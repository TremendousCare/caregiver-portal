// Bookings integration helpers — pure functions, no DB calls, no side
// effects. Imported by execute-automation, bookings-integration, and
// bookings-webhook (all Deno) and by Vitest tests (Node) to lock the
// shape of inbound Microsoft Graph payloads and the per-org config.

// ─── Per-org config path ──────────────────────────────────────────────────
// JSON path inside organizations.settings where the per-org bookings
// config lives. Keep in sync with the migration that seeds it
// (supabase/migrations/20260504000000_bookings_step2_org_config_and_seed_rule.sql).
export const BOOKINGS_SETTINGS_KEY = "bookings";
export const BOOKINGS_PUBLIC_URL_KEY = "public_url";
export const BOOKINGS_BUSINESS_ID_KEY = "business_id";

// Returns the public-facing Microsoft Bookings URL for an org, or empty
// string if not configured. Intentionally permissive on shape — accepts
// null/undefined settings and missing nested keys without throwing.
export function getBookingUrlFromOrgSettings(
  settings: Record<string, any> | null | undefined,
): string {
  if (!settings || typeof settings !== "object") return "";
  const bookings = settings[BOOKINGS_SETTINGS_KEY];
  if (!bookings || typeof bookings !== "object") return "";
  const url = bookings[BOOKINGS_PUBLIC_URL_KEY];
  return typeof url === "string" ? url : "";
}

// Returns the Microsoft Graph bookingBusiness ID for an org, or empty
// string if not configured. Same permissive shape contract.
export function getBookingsBusinessIdFromOrgSettings(
  settings: Record<string, any> | null | undefined,
): string {
  if (!settings || typeof settings !== "object") return "";
  const bookings = settings[BOOKINGS_SETTINGS_KEY];
  if (!bookings || typeof bookings !== "object") return "";
  const id = bookings[BOOKINGS_BUSINESS_ID_KEY];
  return typeof id === "string" ? id : "";
}

// ─── Phone helpers ────────────────────────────────────────────────────────
// Microsoft Bookings does not normalize phone numbers — the customer
// types them by hand into the booking page, so we get every variation
// imaginable: "(555) 867-5309", "555.867.5309", "+1 555 867 5309", etc.
// We strip to the last 10 digits to match against caregivers.phone the
// same way ringcentral-webhook does (see phoneDigits there).

export function phoneDigits(phone: string | null | undefined): string {
  if (!phone || typeof phone !== "string") return "";
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

// ─── Email helpers ────────────────────────────────────────────────────────
// Booking customers can include an email or skip it depending on
// Microsoft's optional-field config. We normalize for case-insensitive
// equality match on caregivers.email — no fancy address parsing, just
// trim + lowercase.

export function normalizeEmail(email: string | null | undefined): string {
  if (!email || typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

// ─── Caregiver matching ───────────────────────────────────────────────────
// Match an inbound appointment to a caregiver by phone (primary) or
// email (fallback). Returns the caregiver row + the match method, or
// `{ caregiver: null, matchMethod: "unmatched" }`.
//
// Caller passes a pre-fetched, org-scoped caregivers array. We do not
// call the DB here — keeps the helper pure and unit-testable.

export interface CaregiverMatchInput {
  id: string;
  phone?: string | null;
  email?: string | null;
}

export interface CaregiverMatchResult<T> {
  caregiver: T | null;
  matchMethod: "phone" | "email" | "unmatched";
}

export function matchCustomerToCaregiver<T extends CaregiverMatchInput>(
  customer: { phone?: string | null; email?: string | null },
  caregivers: T[],
): CaregiverMatchResult<T> {
  const targetPhone = phoneDigits(customer?.phone || "");
  const targetEmail = normalizeEmail(customer?.email || "");

  if (targetPhone) {
    const byPhone = caregivers.find(
      (c) => phoneDigits(c.phone || "") === targetPhone,
    );
    if (byPhone) {
      return { caregiver: byPhone, matchMethod: "phone" };
    }
  }

  if (targetEmail) {
    const byEmail = caregivers.find(
      (c) => normalizeEmail(c.email || "") === targetEmail,
    );
    if (byEmail) {
      return { caregiver: byEmail, matchMethod: "email" };
    }
  }

  return { caregiver: null, matchMethod: "unmatched" };
}

// ─── Microsoft Graph appointment normalization ───────────────────────────
// Graph's bookingAppointment object nests dateTime values under
// dateTimeTimeZone wrappers, customers under an array, and the
// cancellation marker under a separate `cancellationReason` field.
// `normalizeGraphAppointment` produces a flat row matching the
// `caregiver_interviews` table contract — it does NOT include
// caregiver_id or match_method, which the caller fills in after
// running matchCustomerToCaregiver against the org's caregivers.

export interface GraphCustomer {
  customerId?: string | null;
  name?: string | null;
  emailAddress?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export interface GraphAppointment {
  id?: string;
  serviceId?: string | null;
  serviceName?: string | null;
  staffMemberIds?: string[] | null;
  startDateTime?: { dateTime?: string | null; timeZone?: string | null } | null;
  endDateTime?: { dateTime?: string | null; timeZone?: string | null } | null;
  isLocationOnline?: boolean;
  joinWebUrl?: string | null;
  customers?: GraphCustomer[] | null;
  // Cancellation: Graph returns a non-empty string when an appointment
  // has been cancelled. Our local `status` field collapses to a single
  // enum: 'cancelled' if cancellationReason is set, otherwise 'booked'.
  cancellationReason?: string | null;
}

export interface NormalizedAppointment {
  graph_appointment_id: string;
  service_id: string | null;
  service_name: string | null;
  staff_member_ids: string[];
  start_at: string | null;
  end_at: string | null;
  status: "booked" | "cancelled";
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_notes: string | null;
  join_web_url: string | null;
}

// Convert a Graph dateTimeTimeZone wrapper to a UTC ISO string. Graph
// returns naive local times like "2026-05-12T14:30:00.0000000" plus a
// tz string. We render in the tz when displaying, but for storage we
// keep the raw ISO and let Postgres timestamptz parse it. Returns null
// on missing/invalid input rather than throwing — bad data should
// flow through, not crash the webhook.
export function graphDateTimeToIso(
  dt: { dateTime?: string | null; timeZone?: string | null } | null | undefined,
): string | null {
  if (!dt || typeof dt !== "object") return null;
  const raw = dt.dateTime;
  if (!raw || typeof raw !== "string") return null;
  // Postgres timestamptz can parse "2026-05-12T14:30:00" without offset
  // (treating as UTC) but to be explicit and survive future PG
  // configuration drift, append Z when no offset is present. Graph's
  // values are already expressed in UTC for app-only auth callers.
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(raw);
  return hasOffset ? raw : `${raw}Z`;
}

// ─── Interview card state derivation ─────────────────────────────────────
// Pure derivation of the UI state shown on the caregiver detail Interview
// card from the latest caregiver_interviews row. Kept here (not in the
// frontend) so both the React component and its test suite import the
// same implementation, and so an edge function can reuse the logic if
// needed later (e.g. AI context layer summarizing interview state).
//
// Inputs are deliberately permissive: the caller passes the latest row
// (or null) plus a "now" timestamp so the test can pin time. We do NOT
// look at task IDs or phase here — task IDs are admin-configurable and
// would couple this helper to a specific TC pipeline shape.

export type InterviewCardState =
  | "not_yet_booked"  // no row at all
  | "booked"           // row, status=booked, start_at >= now
  | "cancelled"        // row, status=cancelled (most recent state)
  | "completed";       // row, status=booked, start_at < now (presumed past-occurred)

export interface InterviewRowLike {
  status?: string | null;
  start_at?: string | null;
  end_at?: string | null;
}

// `now` is required to keep the function pure and time-pinnable in tests.
export function deriveInterviewCardState(
  row: InterviewRowLike | null | undefined,
  now: number,
): InterviewCardState {
  if (!row) return "not_yet_booked";

  if (row.status === "cancelled") return "cancelled";

  // Only treat past-dated booked rows as completed. Anything else with a
  // valid future start is still booked. Rows with an unparseable start_at
  // fall through to booked rather than completed — the cron just polled
  // them, so they exist for a reason; "booked" is the safe default.
  const startMs = row.start_at ? Date.parse(row.start_at) : Number.NaN;
  if (Number.isFinite(startMs) && startMs < now) {
    return "completed";
  }
  return "booked";
}

// ─── interview_not_scheduled evaluator ───────────────────────────────────
// Decides whether the follow-up automation should fire for one caregiver.
//
// Anchors on the actual booking-URL SMS send (option (b) — see Step 5 PR
// discussion) rather than a phase change or task completion. This is
// task-ID-agnostic: any automation that resolved {{booking_url}} into
// trigger_context counts as "the link went out". Renaming the rule, the
// task, or the merge field doesn't break this — the moment that matters
// is when the URL actually reached the caregiver.
//
// Inputs (all required so the function stays pure and testable):
//   lastSendAt          — ISO timestamp of the most recent successful
//                         booking-URL SMS to this caregiver (null if
//                         none has ever gone out).
//   latestInterviewRow  — most recent caregiver_interviews row, or null.
//                         Only the status field is consulted.
//   daysGap             — config.days_after_send from the rule (must be ≥ 1).
//   alreadyFiredFollowUp — true if THIS rule has already fired a successful
//                         send for this caregiver (idempotency gate; the
//                         caller derives this from automation_log).
//   now                 — ms timestamp; pinnable in tests.

export interface InterviewFollowUpInput {
  lastSendAt: string | null;
  latestInterviewRow: { status?: string | null } | null | undefined;
  daysGap: number;
  alreadyFiredFollowUp: boolean;
  now: number;
}

export type InterviewFollowUpDecision =
  | { fire: false; reason: string }
  | { fire: true };

export function shouldFireInterviewFollowUp(
  input: InterviewFollowUpInput,
): InterviewFollowUpDecision {
  const { lastSendAt, latestInterviewRow, daysGap, alreadyFiredFollowUp, now } = input;

  if (!Number.isFinite(daysGap) || daysGap < 1) {
    return { fire: false, reason: "invalid_days_gap" };
  }
  if (alreadyFiredFollowUp) {
    return { fire: false, reason: "already_fired" };
  }
  if (!lastSendAt) {
    return { fire: false, reason: "no_link_send_recorded" };
  }
  const sentMs = Date.parse(lastSendAt);
  if (!Number.isFinite(sentMs)) {
    return { fire: false, reason: "unparseable_send_timestamp" };
  }
  const ageMs = now - sentMs;
  const requiredMs = daysGap * 24 * 60 * 60 * 1000;
  if (ageMs < requiredMs) {
    return { fire: false, reason: "too_soon" };
  }

  // Active booking blocks follow-up. Cancelled / missing rows do not.
  // We deliberately do NOT block on status='completed' — if a caregiver
  // already had an interview there is no reason to nag them about
  // booking one (but in practice the booked-then-completed case implies
  // they responded to the original send long before the gap elapses).
  const status = latestInterviewRow?.status;
  if (status === "booked") {
    return { fire: false, reason: "currently_booked" };
  }
  if (status === "completed") {
    return { fire: false, reason: "interview_completed" };
  }
  // status === 'cancelled' or row is null/undefined → fire.

  return { fire: true };
}

// ─── interview_not_scheduled lookback window ─────────────────────────────
// Computes how many days back the cron should scan automation_log for the
// original booking-URL send. Must cover the entire span over which a
// recurring cadence could still legitimately fire — otherwise an in-flight
// original send falls out of the lookback window and the anchor
// disappears, silently stopping the cadence before max_reminders is hit.
//
// Worst case for a recurring rule is the last possible nudge, which lands
// at roughly `daysGap + (maxReminders − 1) × intervalDays`. We approximate
// with `daysGap + intervalDays × maxReminders` (over-counts by one
// interval, which is fine — extra margin) and take the max with any
// explicit `stopAfterDays`. A 60-day buffer catches anything else.
//
// Hard-capped at 365 days so a misconfigured rule (e.g. interval_days set
// without max_reminders or stop_after_days) cannot trigger an unbounded
// table scan.
export const INTERVIEW_FOLLOWUP_LOOKBACK_BUFFER_DAYS = 60;
export const INTERVIEW_FOLLOWUP_LOOKBACK_MAX_DAYS = 365;

export function computeInterviewFollowUpLookbackDays(input: {
  daysGap: number;
  intervalDays?: number | null;
  maxReminders?: number | null;
  stopAfterDays?: number | null;
}): number {
  const daysGap = Number.isFinite(input.daysGap) && input.daysGap >= 1
    ? input.daysGap
    : 1;
  const intervalDays =
    Number.isFinite(input.intervalDays as number) && (input.intervalDays as number) >= 1
      ? (input.intervalDays as number)
      : 0;
  const maxReminders =
    Number.isFinite(input.maxReminders as number) && (input.maxReminders as number) >= 1
      ? (input.maxReminders as number)
      : 0;
  const stopAfterDays =
    Number.isFinite(input.stopAfterDays as number) && (input.stopAfterDays as number) >= 1
      ? (input.stopAfterDays as number)
      : 0;

  // Span over which recurring nudges could still fire, measured from the
  // original send. Only meaningful when both interval_days and either
  // max_reminders or stop_after_days are set — otherwise we fall back to
  // the explicit stopAfterDays (or just daysGap for single-fire rules).
  const cadenceSpan =
    intervalDays > 0 && maxReminders > 0
      ? daysGap + intervalDays * maxReminders
      : 0;

  const raw =
    Math.max(daysGap, stopAfterDays, cadenceSpan) +
    INTERVIEW_FOLLOWUP_LOOKBACK_BUFFER_DAYS;

  return Math.min(INTERVIEW_FOLLOWUP_LOOKBACK_MAX_DAYS, raw);
}

// ─── interview_not_scheduled recurring evaluator ─────────────────────────
// Same anchor + booking-status logic as shouldFireInterviewFollowUp, but
// supports a repeating cadence: starting `daysGap` days after the original
// send, fire every `intervalDays` days (spaced by the most recent prior
// follow-up), capped by `maxReminders` and `stopAfterDays`. When any of
// the recurring fields are omitted the function degrades to single-fire
// behavior identical to the original helper, so existing rules without
// the new conditions keep working unchanged.
//
// Inputs:
//   priorFollowUpCount       — number of successful follow-ups already
//                              sent for this rule + caregiver since the
//                              original booking-URL send.
//   lastFollowUpAt           — ISO timestamp of the most recent prior
//                              follow-up (null if none yet).
//   intervalDays             — optional. Spacing between follow-ups. If
//                              omitted/≤0, behaves as single-fire.
//   maxReminders             — optional. Hard cap on total follow-ups.
//                              If omitted, no cap (still bounded by
//                              stopAfterDays).
//   stopAfterDays            — optional. Absolute cutoff measured from
//                              the original send. If omitted, no cutoff
//                              (still bounded by maxReminders).

export interface InterviewFollowUpRecurringInput {
  lastSendAt: string | null;
  latestInterviewRow: { status?: string | null } | null | undefined;
  daysGap: number;
  priorFollowUpCount: number;
  lastFollowUpAt: string | null;
  intervalDays?: number | null;
  maxReminders?: number | null;
  stopAfterDays?: number | null;
  now: number;
}

export function shouldFireInterviewFollowUpRecurring(
  input: InterviewFollowUpRecurringInput,
): InterviewFollowUpDecision {
  const {
    lastSendAt,
    latestInterviewRow,
    daysGap,
    priorFollowUpCount,
    lastFollowUpAt,
    intervalDays,
    maxReminders,
    stopAfterDays,
    now,
  } = input;

  if (!Number.isFinite(daysGap) || daysGap < 1) {
    return { fire: false, reason: "invalid_days_gap" };
  }
  if (!lastSendAt) {
    return { fire: false, reason: "no_link_send_recorded" };
  }
  const sentMs = Date.parse(lastSendAt);
  if (!Number.isFinite(sentMs)) {
    return { fire: false, reason: "unparseable_send_timestamp" };
  }
  const ageMs = now - sentMs;
  const dayMs = 24 * 60 * 60 * 1000;

  // Active or completed booking blocks all follow-ups, current and future.
  const status = latestInterviewRow?.status;
  if (status === "booked") {
    return { fire: false, reason: "currently_booked" };
  }
  if (status === "completed") {
    return { fire: false, reason: "interview_completed" };
  }

  // First nudge — gated solely by daysGap, same as single-fire.
  if (priorFollowUpCount <= 0) {
    if (ageMs < daysGap * dayMs) {
      return { fire: false, reason: "too_soon" };
    }
    return { fire: true };
  }

  // Subsequent nudges — must opt in by setting intervalDays. Without it,
  // the rule behaves as single-fire and we stop after the first nudge.
  const hasInterval = Number.isFinite(intervalDays as number) && (intervalDays as number) > 0;
  if (!hasInterval) {
    return { fire: false, reason: "already_fired" };
  }

  if (Number.isFinite(maxReminders as number) && (maxReminders as number) > 0) {
    if (priorFollowUpCount >= (maxReminders as number)) {
      return { fire: false, reason: "max_reminders_reached" };
    }
  }

  if (Number.isFinite(stopAfterDays as number) && (stopAfterDays as number) > 0) {
    if (ageMs > (stopAfterDays as number) * dayMs) {
      return { fire: false, reason: "past_stop_after_days" };
    }
  }

  // Spacing check against the most recent prior follow-up.
  if (!lastFollowUpAt) {
    // Defensive: count says we've fired, but no timestamp recorded.
    // Treat as "too soon" rather than firing without spacing data.
    return { fire: false, reason: "missing_last_followup_timestamp" };
  }
  const lastMs = Date.parse(lastFollowUpAt);
  if (!Number.isFinite(lastMs)) {
    return { fire: false, reason: "unparseable_last_followup_timestamp" };
  }
  if (now - lastMs < (intervalDays as number) * dayMs) {
    return { fire: false, reason: "interval_not_elapsed" };
  }

  return { fire: true };
}

export function normalizeGraphAppointment(
  appt: GraphAppointment,
): NormalizedAppointment {
  const customers = Array.isArray(appt.customers) ? appt.customers : [];
  const primary: GraphCustomer = customers[0] || {};
  const cancellationReason =
    typeof appt.cancellationReason === "string" ? appt.cancellationReason : "";

  return {
    graph_appointment_id: typeof appt.id === "string" ? appt.id : "",
    service_id: appt.serviceId || null,
    service_name: appt.serviceName || null,
    staff_member_ids: Array.isArray(appt.staffMemberIds)
      ? appt.staffMemberIds.filter((s): s is string => typeof s === "string")
      : [],
    start_at: graphDateTimeToIso(appt.startDateTime),
    end_at: graphDateTimeToIso(appt.endDateTime),
    status: cancellationReason ? "cancelled" : "booked",
    customer_name: primary.name || null,
    customer_email: primary.emailAddress || null,
    customer_phone: primary.phone || null,
    customer_notes: primary.notes || null,
    join_web_url: appt.joinWebUrl || null,
  };
}

// ─── Interview reminder (pre-interview SMS) ──────────────────────────────
// Pure helpers for the `interview_reminder` automation trigger. The cron
// runs every 5 minutes and asks two questions per interview × per
// configured lead time:
//   1. Is the interview's start_at currently inside the firing window for
//      this lead time? (parseInterviewReminderMinutes + isInReminderWindow)
//   2. Has a reminder for this (rule, interview, minutes_before) already
//      been sent? (caller queries automation_log)
//
// Window math: a 5-min cron with a ±N min lead time needs a window wide
// enough that at least one tick falls inside, but narrow enough that we
// don't double-fire across ticks. We pick [target − 5min, target] — a
// closed-open 5-minute window aligned so the reminder fires AT OR JUST
// AFTER the intended lead time, never before. Combined with per-(rule,
// interview, minutes_before) dedup keyed on automation_log, this gives
// "exactly once per configured lead time" semantics under the 5-min cron.

export const INTERVIEW_REMINDER_WINDOW_MS = 5 * 60 * 1000;

// Parse the rule's conditions.minutes_before into a deduped, sorted array
// of positive integers. Accepts:
//   • a single number (15)
//   • an array of numbers ([15, 60])
//   • a string of comma-separated numbers ("15, 60") — the UI uses this
//     because <input type="text"> keeps the value editable while typing
// Returns [] if nothing parses, so the caller can short-circuit cleanly.
export function parseInterviewReminderMinutes(
  raw: number | string | (number | string)[] | null | undefined,
): number[] {
  if (raw === null || raw === undefined) return [];
  const items: Array<number | string> = Array.isArray(raw) ? raw : [raw];
  const parsed: number[] = [];
  for (const item of items) {
    if (typeof item === "number") {
      if (Number.isFinite(item) && item > 0 && Number.isInteger(item)) {
        parsed.push(item);
      }
      continue;
    }
    if (typeof item === "string") {
      // Allow "15", "15, 60", "15,60,1440" etc.
      for (const part of item.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const n = Number(trimmed);
        if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) {
          parsed.push(n);
        }
      }
    }
  }
  // Dedup + sort descending so 1440-minute (24h) reminders are evaluated
  // before 15-minute reminders when iterating. Order doesn't affect
  // correctness — dedup is keyed on minutes_before — but a stable order
  // keeps logs and tests deterministic.
  return Array.from(new Set(parsed)).sort((a, b) => b - a);
}

export interface InterviewReminderWindowInput {
  startAt: string | null | undefined;
  minutesBefore: number;
  now: number;
  windowMs?: number;
}

// Is the interview's start_at currently inside the firing window for the
// given lead time? Returns false on missing/unparseable start_at so the
// caller can rely on truthy = "fire it".
//
// Window is [start - minutesBefore, start - minutesBefore + windowMs)
// — i.e. fires AT the target lead time or up to windowMs after, never
// before. The 5-min default matches the cron cadence.
export function isInReminderWindow(input: InterviewReminderWindowInput): boolean {
  const { startAt, minutesBefore, now, windowMs = INTERVIEW_REMINDER_WINDOW_MS } = input;
  if (!startAt) return false;
  if (!Number.isFinite(minutesBefore) || minutesBefore <= 0) return false;
  const startMs = Date.parse(startAt);
  if (!Number.isFinite(startMs)) return false;
  const targetMs = startMs - minutesBefore * 60 * 1000;
  return now >= targetMs && now < targetMs + windowMs;
}

// Returns the lookahead horizon needed to fetch candidate interviews for
// a given set of configured lead times. The cron uses this to bound the
// SQL `start_at <= now + horizon` filter so it doesn't scan the entire
// future interviews table. Adds a small buffer for cron jitter.
export function computeInterviewReminderLookaheadMs(
  minutesBeforeList: number[],
  windowMs: number = INTERVIEW_REMINDER_WINDOW_MS,
): number {
  if (!minutesBeforeList || minutesBeforeList.length === 0) return 0;
  const maxMinutes = Math.max(...minutesBeforeList);
  return maxMinutes * 60 * 1000 + windowMs;
}

// Format an interview start time in the org's local TZ for inclusion in
// SMS templates ({{interview_start_text}}). Falls back to the raw ISO if
// the TZ is bogus. Matches the format used by shift_reminder_24h so
// caregivers see one consistent time style across all automation SMS.
export function formatInterviewStartText(
  startAt: string | null | undefined,
  timeZone: string = "America/New_York",
): string {
  if (!startAt) return "";
  const ms = Date.parse(startAt);
  if (!Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(new Date(ms));
  } catch {
    return startAt;
  }
}

// Status values for caregiver_interviews that should still trigger a
// reminder. 'rescheduled' rows have a new start_at and behave like fresh
// bookings; everything else (cancelled, completed, no_show) skips.
export const INTERVIEW_REMINDER_ACTIVE_STATUSES = ["booked", "rescheduled"] as const;

export function isInterviewStatusReminderEligible(
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  return (INTERVIEW_REMINDER_ACTIVE_STATUSES as readonly string[]).includes(status);
}
