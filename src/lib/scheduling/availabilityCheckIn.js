// ═══════════════════════════════════════════════════════════════
// Availability Check-In — Pure Helpers
//
// These functions contain all the decision logic the recurring
// availability check-in cron will use (PR 4). Keeping them as pure
// functions in the frontend source tree means:
//   - They're unit-testable with no DB / no edge-function runtime
//   - The edge function can duplicate them verbatim (see
//     prescreenAvailability.js for the same pattern)
//   - Any future consumer (e.g. an ad-hoc send UI) reuses the same
//     exact decisions the cron makes
//
// NOTHING in this file sends an SMS or talks to the database.
// ═══════════════════════════════════════════════════════════════

/**
 * Is this caregiver currently "active" — eligible to receive an
 * availability check-in at all?
 *
 * A caregiver is active when:
 *   - NOT archived
 *   - NOT globally opted out of SMS (sms_opted_out)
 *   - NOT paused from availability check-ins specifically
 *     (availability_check_paused)
 *
 * Accepts both camelCase (frontend mapper) and snake_case (raw DB row
 * inside the edge function) shapes so the same function works on
 * either side.
 */
export function isActiveForAvailabilityCheckIn(caregiver) {
  if (!caregiver) return false;
  const archived = caregiver.archived === true || caregiver.archived === 'true';
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
export function matchesPhaseFilter(caregiverPhase, conditionPhase) {
  if (conditionPhase === null || conditionPhase === undefined || conditionPhase === '') {
    return true;
  }
  if (Array.isArray(conditionPhase)) {
    if (conditionPhase.length === 0) return true;
    return conditionPhase.includes(caregiverPhase);
  }
  return caregiverPhase === conditionPhase;
}

/**
 * Apply all active-caregiver filters in one pass. Used by the cron
 * when iterating every caregiver for a rule. Callers should then
 * additionally apply `isDueForAvailabilityCheck` against each
 * caregiver's last-fired timestamp.
 */
export function filterActiveCaregiversForCheckIn(caregivers, conditions = {}) {
  if (!Array.isArray(caregivers)) return [];
  const phase = conditions.phase;
  return caregivers.filter((cg) => {
    if (!isActiveForAvailabilityCheckIn(cg)) return false;
    const cgPhase = cg.phase || cg.phaseOverride || cg.phase_override || null;
    return matchesPhaseFilter(cgPhase, phase);
  });
}

/**
 * Has enough time elapsed since the last time this rule fired for
 * this caregiver? Returns true when either no prior fire is on
 * record, or the elapsed time is >= intervalDays.
 *
 * @param {string|Date|null} lastFiredAt  ISO timestamp or null for "never fired"
 * @param {number}           intervalDays positive integer (days)
 * @param {Date}             now          defaults to current time; injectable for tests
 */
export function isDueForAvailabilityCheck(lastFiredAt, intervalDays, now = new Date()) {
  if (!Number.isFinite(intervalDays) || intervalDays <= 0) {
    throw new Error('intervalDays must be a positive number');
  }
  if (lastFiredAt === null || lastFiredAt === undefined) return true;

  const lastFired =
    lastFiredAt instanceof Date ? lastFiredAt : new Date(lastFiredAt);
  if (Number.isNaN(lastFired.getTime())) return true;

  const msElapsed = now.getTime() - lastFired.getTime();
  const msInterval = intervalDays * 24 * 60 * 60 * 1000;
  return msElapsed >= msInterval;
}

/**
 * Is the given survey template suitable to be sent as an availability
 * check-in? It must contain at least one question of type
 * `availability_schedule`. The recurring automation rule can only be
 * pointed at templates that satisfy this check — otherwise the
 * caregiver would submit an answer that doesn't wire through to the
 * sync_availability_from_survey path.
 */
export function isValidAvailabilityTemplate(template) {
  if (!template || typeof template !== 'object') return false;
  const questions = Array.isArray(template.questions) ? template.questions : [];
  return questions.some((q) => q && q.type === 'availability_schedule');
}

/**
 * Is the configured send window currently open?
 *
 *   now — current Date
 *   startHour — inclusive, 0-23
 *   endHour — exclusive, 0-24 (24 means "midnight")
 *
 * Mirrors the existing `isWithinSendWindow` helper from the survey
 * reminder cron so admins don't have to learn two different mental
 * models for "when are automations allowed to fire?" Supports an
 * overnight window where endHour < startHour (e.g. 22–6).
 */
export function isWithinSendWindow(now, startHour, endHour) {
  if (!(now instanceof Date)) return false;
  const h = now.getHours();
  // When the window doesn't wrap past midnight (e.g. 9–17)
  if (startHour <= endHour) {
    return h >= startHour && h < endHour;
  }
  // Overnight window (e.g. 22–6): open from startHour to midnight OR from midnight to endHour
  return h >= startHour || h < endHour;
}
