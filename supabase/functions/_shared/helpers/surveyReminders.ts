// --- Survey Reminder Helpers ---
// Pure functions for the survey_pending automation trigger.
// Isolated here so they can be unit-tested without Deno / Supabase.
//
// Used by supabase/functions/automation-cron/index.ts (Section 1.5).

import { getPhase } from "./caregiver.ts";

export interface SurveyReminderConditions {
  hours?: number;          // Interval between reminders. Default: 24
  max_reminders?: number;  // Max reminders before giving up. Default: 5
  tz?: string;             // IANA tz for the send window. Default: America/New_York
  start_hour?: number;     // Local hour the send window opens (0-23). Default: 9
  end_hour?: number;       // Local hour the send window closes (0-23, exclusive). Default: 18
  phase?: string;          // Optional "Only in Phase" filter (phase id, e.g. "intake").
                           // When set, reminders are only sent to caregivers whose
                           // computed phase matches. Unset = send regardless of phase.
}

export const DEFAULT_REMINDER_HOURS = 24;
export const DEFAULT_MAX_REMINDERS = 5;
export const DEFAULT_TZ = "America/New_York";
export const DEFAULT_START_HOUR = 9;
export const DEFAULT_END_HOUR = 18;

/**
 * Resolve reminder conditions from an automation rule, applying defaults.
 */
export function resolveReminderConditions(
  conditions: SurveyReminderConditions | null | undefined,
): Required<SurveyReminderConditions> {
  const c = conditions || {};
  return {
    hours: typeof c.hours === "number" && c.hours > 0 ? c.hours : DEFAULT_REMINDER_HOURS,
    max_reminders:
      typeof c.max_reminders === "number" && c.max_reminders > 0
        ? c.max_reminders
        : DEFAULT_MAX_REMINDERS,
    tz: c.tz || DEFAULT_TZ,
    start_hour:
      typeof c.start_hour === "number" && c.start_hour >= 0 && c.start_hour <= 23
        ? c.start_hour
        : DEFAULT_START_HOUR,
    end_hour:
      typeof c.end_hour === "number" && c.end_hour >= 0 && c.end_hour <= 24
        ? c.end_hour
        : DEFAULT_END_HOUR,
  };
}

/**
 * Return true if `now` is inside the configured send window for the given
 * IANA timezone. The window is [startHour, endHour) — i.e. endHour is exclusive,
 * so a 9-18 window sends between 9:00am and 5:59pm local time.
 *
 * Falsy/invalid timezones fall back to UTC hours.
 */
export function isWithinSendWindow(
  now: Date,
  tz: string,
  startHour: number,
  endHour: number,
): boolean {
  if (startHour >= endHour) return false; // degenerate window: never send
  let localHour: number;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    // Intl can return "24" for midnight in some locales; normalize.
    const parsed = parseInt(fmt.format(now), 10);
    localHour = Number.isFinite(parsed) ? parsed % 24 : now.getUTCHours();
  } catch {
    localHour = now.getUTCHours();
  }
  return localHour >= startHour && localHour < endHour;
}

/**
 * Return true if a survey response is due for its next reminder.
 *
 * Rules:
 *  - If it has never been reminded (`lastReminderSentAt` is null/undefined),
 *    it's due as long as the initial send was more than `intervalHours` ago.
 *  - Otherwise, due if `intervalHours` have elapsed since the last reminder.
 *  - A small safety tolerance (2 minutes) is subtracted so that a rule
 *    configured for "every 24 hours" doesn't get pushed back 30 minutes each
 *    time by the cron cadence — without this, a 24h rule would drift to 24.5h
 *    then 25h, etc.
 */
export function isReminderDue(
  sentAt: string | Date | null | undefined,
  lastReminderSentAt: string | Date | null | undefined,
  intervalHours: number,
  now: Date,
): boolean {
  if (intervalHours <= 0) return false;
  const toleranceMs = 2 * 60 * 1000;
  const intervalMs = intervalHours * 60 * 60 * 1000 - toleranceMs;
  const reference = lastReminderSentAt ?? sentAt;
  if (!reference) return true;
  const refMs = new Date(reference).getTime();
  if (!Number.isFinite(refMs)) return true;
  return now.getTime() - refMs >= intervalMs;
}

/**
 * Return true if we should send another reminder for this survey response.
 * Combines the reminder cap with the due-time check.
 */
export function shouldRemindSurvey(
  response: {
    status?: string;
    reminders_stopped?: boolean | null;
    reminders_sent?: number | null;
    sent_at?: string | Date | null;
    last_reminder_sent_at?: string | Date | null;
  },
  conditions: SurveyReminderConditions | null | undefined,
  now: Date,
): boolean {
  if (response.status !== "pending") return false;
  if (response.reminders_stopped) return false;
  const resolved = resolveReminderConditions(conditions);
  const sent = response.reminders_sent ?? 0;
  if (sent >= resolved.max_reminders) return false;
  return isReminderDue(
    response.sent_at ?? null,
    response.last_reminder_sent_at ?? null,
    resolved.hours,
    now,
  );
}

/**
 * Build the public survey URL for a token. Mirrors the client-side
 * buildSurveyUrl in src/lib/surveyUtils.js, but safe to call from Deno
 * (no window global).
 */
export function buildSurveyUrlFromToken(token: string, baseUrl: string): string {
  const base = (baseUrl || "").replace(/\/+$/, "");
  return `${base}/survey/${token}`;
}

/**
 * Decide whether a survey_pending reminder rule applies to a given caregiver.
 * Used by the cron to enforce the "Only in Phase" filter on the rule.
 *
 * Rules:
 *  - Archived caregivers never get reminders.
 *  - No phase filter on the rule → all non-archived caregivers match.
 *  - Phase filter set → caregiver's computed phase must equal the filter.
 */
export function ruleAppliesToCaregiver(
  caregiver: {
    archived?: boolean | null;
    phase_override?: string | null;
    phase_timestamps?: Record<string, number> | null;
  } | null | undefined,
  conditions: SurveyReminderConditions | null | undefined,
): boolean {
  if (!caregiver) return false;
  if (caregiver.archived) return false;
  const phaseFilter =
    typeof conditions?.phase === "string" && conditions.phase
      ? conditions.phase
      : null;
  if (!phaseFilter) return true;
  return getPhase(caregiver) === phaseFilter;
}
