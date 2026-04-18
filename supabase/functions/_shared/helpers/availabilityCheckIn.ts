// --- Availability Check-In Helpers ---
// Pure functions for the `recurring_availability_check` automation trigger.
// Isolated here so they can be imported by both the automation-cron edge
// function (Section 1.7) and the frontend vitest suite without any runtime
// dependency on Deno or Supabase.
//
// The shared-helper pattern matches supabase/functions/_shared/helpers/
// surveyReminders.ts — single source of truth, tested from the frontend
// via a direct .ts import.

export interface AvailabilityCheckInConditions {
  interval_days?: number;       // How often to re-send. Default: 14
  survey_template_id?: string;  // Which template to send (required on real rules).
  phase?: string | string[] | null; // Optional phase filter (id or list of ids).
  start_hour?: number;          // Local hour the send window opens (0-23). Default: 9
  end_hour?: number;            // Local hour the send window closes (0-24, exclusive). Default: 17
  tz?: string;                  // IANA tz for the send window. Default: America/New_York
}

export const DEFAULT_INTERVAL_DAYS = 14;
export const DEFAULT_START_HOUR = 9;
export const DEFAULT_END_HOUR = 17;
export const DEFAULT_TZ = "America/New_York";

/**
 * Resolve a rule's conditions with defaults applied. Mirrors the pattern
 * in surveyReminders.ts so admins work with the same mental model across
 * automation trigger types.
 */
export function resolveAvailabilityCheckInConditions(
  conditions: AvailabilityCheckInConditions | null | undefined,
): Required<Omit<AvailabilityCheckInConditions, "survey_template_id" | "phase">> & {
  survey_template_id: string | null;
  phase: string | string[] | null;
} {
  const c = conditions || {};
  return {
    interval_days:
      typeof c.interval_days === "number" && c.interval_days > 0
        ? c.interval_days
        : DEFAULT_INTERVAL_DAYS,
    survey_template_id: c.survey_template_id || null,
    phase: c.phase ?? null,
    start_hour:
      typeof c.start_hour === "number" && c.start_hour >= 0 && c.start_hour <= 23
        ? c.start_hour
        : DEFAULT_START_HOUR,
    end_hour:
      typeof c.end_hour === "number" && c.end_hour >= 0 && c.end_hour <= 24
        ? c.end_hour
        : DEFAULT_END_HOUR,
    tz: c.tz || DEFAULT_TZ,
  };
}

/**
 * Is a caregiver currently "active" — eligible to receive an
 * availability check-in at all?
 *
 *   - NOT archived
 *   - NOT globally opted out of SMS (sms_opted_out)
 *   - NOT paused from availability check-ins specifically
 *     (availability_check_paused)
 *
 * Accepts both camelCase (frontend mapper) and snake_case (raw DB row
 * inside the edge function) shapes so the same function works on
 * either side.
 */
export function isActiveForAvailabilityCheckIn(
  caregiver: Record<string, unknown> | null | undefined,
): boolean {
  if (!caregiver) return false;
  const archived =
    caregiver.archived === true || caregiver.archived === "true";
  if (archived) return false;

  const smsOptedOut =
    caregiver.smsOptedOut === true || caregiver.sms_opted_out === true;
  if (smsOptedOut) return false;

  const availabilityPaused =
    caregiver.availabilityCheckPaused === true ||
    caregiver.availability_check_paused === true;
  if (availabilityPaused) return false;

  return true;
}

/**
 * Is a caregiver currently in one of the rule's allowed phases?
 * Returns true when the rule has no phase filter (allows all phases)
 * or when the caregiver's phase is in the configured list.
 */
export function matchesPhaseFilter(
  caregiverPhase: string | null | undefined,
  conditionPhase: string | string[] | null | undefined,
): boolean {
  if (conditionPhase === null || conditionPhase === undefined || conditionPhase === "") {
    return true;
  }
  if (Array.isArray(conditionPhase)) {
    if (conditionPhase.length === 0) return true;
    return conditionPhase.includes(caregiverPhase || "");
  }
  return caregiverPhase === conditionPhase;
}

/**
 * Apply all active-caregiver filters in one pass.
 */
export function filterActiveCaregiversForCheckIn(
  caregivers: Array<Record<string, unknown>> | null | undefined,
  conditions: AvailabilityCheckInConditions = {},
): Array<Record<string, unknown>> {
  if (!Array.isArray(caregivers)) return [];
  const phase = conditions.phase ?? null;
  return caregivers.filter((cg) => {
    if (!isActiveForAvailabilityCheckIn(cg)) return false;
    const cgPhase =
      (cg.phase as string | undefined) ||
      (cg.phaseOverride as string | undefined) ||
      (cg.phase_override as string | undefined) ||
      null;
    return matchesPhaseFilter(cgPhase, phase);
  });
}

/**
 * Has enough time elapsed since the last time this rule fired for
 * this caregiver? Returns true when either no prior fire is on
 * record, or the elapsed time is >= intervalDays.
 *
 * A small safety tolerance (2 minutes) is subtracted so a rule
 * configured for "every 14 days" doesn't drift to 14.5 days on each
 * fire because of cron scheduling jitter.
 */
export function isDueForAvailabilityCheck(
  lastFiredAt: string | Date | null | undefined,
  intervalDays: number,
  now: Date = new Date(),
): boolean {
  if (!Number.isFinite(intervalDays) || intervalDays <= 0) {
    throw new Error("intervalDays must be a positive number");
  }
  if (lastFiredAt === null || lastFiredAt === undefined) return true;

  const lastFired =
    lastFiredAt instanceof Date ? lastFiredAt : new Date(lastFiredAt as string);
  if (Number.isNaN(lastFired.getTime())) return true;

  const toleranceMs = 2 * 60 * 1000;
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000 - toleranceMs;
  return now.getTime() - lastFired.getTime() >= intervalMs;
}

/**
 * Is the given survey template suitable to be sent as an availability
 * check-in? It must contain at least one question of type
 * `availability_schedule`. The recurring automation rule can only be
 * pointed at templates that satisfy this check — otherwise the
 * caregiver would submit an answer that doesn't wire through to the
 * sync_availability_from_survey path.
 */
export function isValidAvailabilityTemplate(
  template: Record<string, unknown> | null | undefined,
): boolean {
  if (!template || typeof template !== "object") return false;
  const questions = Array.isArray((template as any).questions)
    ? (template as any).questions
    : [];
  return questions.some(
    (q: Record<string, unknown> | null) =>
      !!q && q.type === "availability_schedule",
  );
}

/**
 * Is `now` inside the configured send window for the given IANA
 * timezone? The window is [startHour, endHour) — endHour exclusive.
 * Supports overnight windows where endHour < startHour. Falsy/invalid
 * timezones fall back to UTC hours.
 */
export function isWithinSendWindow(
  now: Date,
  tz: string,
  startHour: number,
  endHour: number,
): boolean {
  if (!(now instanceof Date)) return false;
  let localHour: number;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const parsed = parseInt(fmt.format(now), 10);
    localHour = Number.isFinite(parsed) ? parsed % 24 : now.getUTCHours();
  } catch {
    localHour = now.getUTCHours();
  }
  if (startHour <= endHour) {
    return localHour >= startHour && localHour < endHour;
  }
  // Overnight window (e.g. 22-6)
  return localHour >= startHour || localHour < endHour;
}
