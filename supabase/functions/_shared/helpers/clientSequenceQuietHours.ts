// ─── Client Sequence Quiet Hours (Phase 1) ───
//
// Org-wide, timezone-naive quiet-hours gating for the client-pipeline
// drip-campaign runner in supabase/functions/automation-cron/index.ts.
//
// V1 deliberately keeps this dead simple:
//   • Active send window: 9:00 AM – 7:00 PM America/Los_Angeles, every
//     day of the week (weekends are in-window).
//   • Quiet window: 7:00 PM through 9:00 AM the next morning (overnight
//     wrap). startHour > endHour is the wrapping form understood by
//     leadNotifications.isInQuietHours.
//   • All leads are treated as if they live in our business timezone.
//     We do NOT consult a per-client timezone column — there isn't one
//     yet. Phase 2 will add `clients.timezone`; Phase 3 will move
//     these constants into organizations.settings.
//
// What this gates: cron-executed SMS/email steps in client_sequences
// (the day-2, day-3, … follow-ups). Day-1 immediate sends fire from
// the frontend on lead entry (delay_hours === 0) and intentionally
// bypass this gate — when a lead just submitted a form, they're
// awake and expecting contact.
//
// What this does NOT gate: create_task steps (internal note writes,
// not customer-facing); caregiver-side automations (which have their
// own per-rule send-window logic in surveyReminders.ts); or any of
// the staff-facing dispatch-lead-notifications quiet hours (which
// has its own per-org configurable window).

import { isInQuietHours, nextSendTime } from "./leadNotifications.ts";

export const CLIENT_SEQUENCE_QUIET_HOURS_TZ = "America/Los_Angeles";
// Wrapping window: quiet zone is [19, 24) ∪ [0, 9), i.e. 7pm through
// 9am the next morning. Equivalent active window: 9am–7pm.
export const CLIENT_SEQUENCE_QUIET_HOURS_START_HOUR = 19;
export const CLIENT_SEQUENCE_QUIET_HOURS_END_HOUR = 9;

export function isClientSequenceInQuietHours(now: Date): boolean {
  return isInQuietHours(
    now,
    CLIENT_SEQUENCE_QUIET_HOURS_TZ,
    CLIENT_SEQUENCE_QUIET_HOURS_START_HOUR,
    CLIENT_SEQUENCE_QUIET_HOURS_END_HOUR,
  );
}

export function nextClientSequenceSendTime(now: Date): Date {
  return nextSendTime(
    now,
    CLIENT_SEQUENCE_QUIET_HOURS_TZ,
    CLIENT_SEQUENCE_QUIET_HOURS_START_HOUR,
    CLIENT_SEQUENCE_QUIET_HOURS_END_HOUR,
  );
}
