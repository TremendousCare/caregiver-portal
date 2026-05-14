// ═══════════════════════════════════════════════════════════════
// Scheduling — Caregiver rule conflict detection
//
// Pure helpers that check whether a proposed regular-caregiver rule
// would conflict with the same caregiver's existing commitments on
// the same day of the week.
//
// What this checks
// ----------------
// 1. **Rule-vs-rule conflicts**: the same caregiver is already
//    listed as the regular on a different service plan with an
//    overlapping wall-clock window and an overlapping effective
//    date range.
// 2. **Rule-vs-shift conflicts**: the caregiver has a one-off shift
//    on a specific date within the proposed rule's effective range
//    whose time window overlaps the rule's pattern.
//
// What this does NOT check
// ------------------------
// - Caregiver stated availability (the form layer surfaces that
//   separately, with a softer warning).
// - Hours-per-week caps, blackouts, time-off requests. These will
//   come as separate sources of truth once their data models exist
//   (see docs/SCHEDULING_CAREGIVER_RULES.md).
//
// All inputs are plain JS objects. No I/O. Easy to test.
// ═══════════════════════════════════════════════════════════════

/**
 * Do two wall-clock minute ranges overlap on a single day?
 * Handles overnight ranges where end < start by treating the range
 * as wrapping past midnight (e.g. 22:00 → 06:00 covers 22:00–24:00
 * AND 00:00–06:00). Touching edges do not count as overlap.
 *
 * @param {number} aStart  Start minute (0..1439) of range A
 * @param {number} aEnd    End minute. If <= aStart, range wraps past midnight.
 * @param {number} bStart
 * @param {number} bEnd
 * @returns {boolean}
 */
export function clockRangesOverlap(aStart, aEnd, bStart, bEnd) {
  // Normalize each range into one or two non-wrapping segments.
  const asA = aEnd > aStart ? [[aStart, aEnd]] : [[aStart, 1440], [0, aEnd]];
  const asB = bEnd > bStart ? [[bStart, bEnd]] : [[bStart, 1440], [0, bEnd]];
  for (const [s1, e1] of asA) {
    for (const [s2, e2] of asB) {
      if (s1 < e2 && s2 < e1) return true;
    }
  }
  return false;
}

/**
 * Parse 'HH:MM' clock string to minutes-since-midnight. Returns null
 * on malformed input so callers can skip rather than throw.
 */
export function clockToMinutes(clock) {
  if (typeof clock !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Do two effective date ranges (inclusive, `effective_to=null` means
 * open-ended) overlap?
 */
export function dateRangesOverlap(aFrom, aTo, bFrom, bTo) {
  if (!aFrom || !bFrom) return false;
  // a ends before b starts → no overlap.
  if (aTo && aTo < bFrom) return false;
  // b ends before a starts → no overlap.
  if (bTo && bTo < aFrom) return false;
  return true;
}

/**
 * Find existing rules for the same caregiver that would conflict with
 * a proposed rule. The proposed rule's recurrence pattern is the
 * pattern from the service plan it's about to be saved on — its
 * start/end times define the wall-clock window. Each existing rule
 * carries its own service plan's recurrence pattern, which we need
 * for time comparison.
 *
 * @param {object} proposed
 * @param {string} proposed.caregiverId
 * @param {string} proposed.servicePlanId    The plan the proposed rule is on
 * @param {number} proposed.dayOfWeek
 * @param {string} proposed.startClock       'HH:MM' from the plan's pattern
 * @param {string} proposed.endClock         'HH:MM' from the plan's pattern
 * @param {string} proposed.effectiveFrom    'YYYY-MM-DD'
 * @param {string|null} [proposed.effectiveTo]
 * @param {Array<object>} existingRulesWithPattern
 *   Array of rules belonging to the same caregiver across all plans,
 *   each enriched with `{ pattern_start_clock, pattern_end_clock }`
 *   from the plan's recurrence_pattern. Shape:
 *   {
 *     id, service_plan_id, day_of_week, caregiver_id,
 *     effective_from, effective_to,
 *     pattern_start_clock, pattern_end_clock,
 *   }
 * @returns {Array<object>} conflicting rules (same shape as input)
 */
export function findRuleConflicts(proposed, existingRulesWithPattern) {
  if (!proposed) return [];
  if (!Array.isArray(existingRulesWithPattern)) return [];

  const propStart = clockToMinutes(proposed.startClock);
  const propEnd = clockToMinutes(proposed.endClock);
  if (propStart == null || propEnd == null) return [];

  const conflicts = [];
  for (const rule of existingRulesWithPattern) {
    if (!rule) continue;
    if (rule.caregiver_id !== proposed.caregiverId) continue;
    if (rule.day_of_week !== proposed.dayOfWeek) continue;
    // Same-plan rules are handled by the upsert/expire logic in
    // planRuleUpsert; they're not a conflict, they're a hand-off.
    if (rule.service_plan_id === proposed.servicePlanId) continue;
    if (
      !dateRangesOverlap(
        rule.effective_from,
        rule.effective_to,
        proposed.effectiveFrom,
        proposed.effectiveTo ?? null,
      )
    ) {
      continue;
    }
    const ruleStart = clockToMinutes(rule.pattern_start_clock);
    const ruleEnd = clockToMinutes(rule.pattern_end_clock);
    if (ruleStart == null || ruleEnd == null) continue;
    if (!clockRangesOverlap(propStart, propEnd, ruleStart, ruleEnd)) continue;
    conflicts.push(rule);
  }
  return conflicts;
}

/**
 * Find one-off shifts assigned to this caregiver that would conflict
 * with the proposed rule. We don't need to check rule-driven shifts
 * because those are covered by `findRuleConflicts`; this is for
 * shifts that the team manually assigned outside of any rule.
 *
 * @param {object} proposed                 same shape as findRuleConflicts
 * @param {Array<object>} existingShifts    shifts assigned to this caregiver,
 *   each at minimum: { id, start_time, end_time, status, service_plan_id, recurrence_group_id }
 * @returns {Array<object>}
 */
export function findShiftConflicts(proposed, existingShifts) {
  if (!proposed) return [];
  if (!Array.isArray(existingShifts)) return [];

  const propStart = clockToMinutes(proposed.startClock);
  const propEnd = clockToMinutes(proposed.endClock);
  if (propStart == null || propEnd == null) return [];

  const conflicts = [];
  for (const shift of existingShifts) {
    if (!shift) continue;
    if (!shift.start_time || !shift.end_time) continue;
    // Skip cancelled / completed / no-show shifts.
    const status = shift.status;
    if (status === 'cancelled' || status === 'completed' || status === 'no_show') continue;

    // Day-of-week and date scoping: only flag shifts within the
    // proposed rule's effective range whose calendar day matches the
    // rule's day_of_week.
    const startDate = String(shift.start_time).slice(0, 10);
    if (startDate < proposed.effectiveFrom) continue;
    if (proposed.effectiveTo && startDate > proposed.effectiveTo) continue;

    const dt = new Date(shift.start_time);
    if (Number.isNaN(dt.getTime())) continue;
    if (dt.getUTCDay() !== proposed.dayOfWeek) continue;

    const shiftStartMin = dt.getUTCHours() * 60 + dt.getUTCMinutes();
    const endDt = new Date(shift.end_time);
    if (Number.isNaN(endDt.getTime())) continue;
    const shiftEndMin = endDt.getUTCHours() * 60 + endDt.getUTCMinutes();

    if (!clockRangesOverlap(propStart, propEnd, shiftStartMin, shiftEndMin)) continue;
    conflicts.push(shift);
  }
  return conflicts;
}
