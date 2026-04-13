// ═══════════════════════════════════════════════════════════════
// Scheduling — Conflict Detection
//
// Pure functions for determining whether a proposed shift conflicts
// with a caregiver's existing shifts. Used by:
//   - Manual shift assignment (Phase 4): warn before creating conflicts
//   - Availability matching (Phase 2+): eligibility ranking
//   - AI tools (Phase 8): closed-loop auto-assignment
//
// All functions are pure — they take data as arguments and return
// plain values. No I/O, no side effects, no Supabase calls. This
// keeps them trivial to test and safe to call from anywhere.
// ═══════════════════════════════════════════════════════════════

/**
 * Default travel time buffer between shifts at different locations.
 * When a caregiver has back-to-back shifts with different clients,
 * they need time to drive from one to the next. Back-to-back shifts
 * with the same client are allowed to touch.
 *
 * 30 minutes is a reasonable urban default. Can be overridden per
 * call for rural areas or stricter policies.
 */
export const DEFAULT_TRAVEL_BUFFER_MINUTES = 30;

/**
 * Shift statuses that should block new shifts (i.e. occupy the
 * caregiver's time). Cancelled / no_show / completed shifts are
 * ignored because they no longer consume the caregiver's schedule.
 */
const BLOCKING_STATUSES = new Set([
  'assigned',
  'confirmed',
  'in_progress',
]);

/**
 * Normalize a time value to a millisecond timestamp.
 * Accepts Date, ISO string, or number.
 */
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  throw new Error(`Invalid time value: ${value}`);
}

/**
 * Do two time ranges overlap?
 * Touching edges (A.end === B.start) are NOT considered overlapping.
 *
 * @param {number} aStart  Start of range A (ms)
 * @param {number} aEnd    End of range A (ms)
 * @param {number} bStart  Start of range B (ms)
 * @param {number} bEnd    End of range B (ms)
 * @returns {boolean}
 */
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Expand an existing shift's occupied window to include travel buffer.
 * Only applies the buffer on the side facing the proposed shift, and
 * only if the existing shift is for a different client.
 *
 * Same-client back-to-back shifts require no buffer (already on-site).
 *
 * @param {object} existing    Shift to expand { start_time, end_time, client_id }
 * @param {object} proposed    Proposed shift { start_time, end_time, client_id }
 * @param {number} bufferMs    Travel buffer in ms
 * @returns {{ start: number, end: number }}  Effective blocked window
 */
function expandWithBuffer(existing, proposed, bufferMs) {
  const existingStart = toMs(existing.start_time);
  const existingEnd = toMs(existing.end_time);
  const proposedStart = toMs(proposed.start_time);
  const proposedEnd = toMs(proposed.end_time);

  // Same client? No travel time needed.
  if (existing.client_id && proposed.client_id && existing.client_id === proposed.client_id) {
    return { start: existingStart, end: existingEnd };
  }

  // Different clients — add buffer on the side facing the proposed shift.
  // If proposed comes after existing, add buffer to existing's end.
  // If proposed comes before existing, add buffer to existing's start.
  // If they overlap, both sides are extended (maximally conservative).
  let bufferedStart = existingStart;
  let bufferedEnd = existingEnd;

  if (proposedStart >= existingEnd) {
    // proposed is strictly after existing → drive from existing to next
    bufferedEnd = existingEnd + bufferMs;
  } else if (proposedEnd <= existingStart) {
    // proposed is strictly before existing → drive from proposed to existing
    bufferedStart = existingStart - bufferMs;
  } else {
    // they actually overlap — no buffer math needed, overlap is already a conflict
    // Leave as-is.
  }

  return { start: bufferedStart, end: bufferedEnd };
}

/**
 * Check whether a proposed shift conflicts with any of the existing
 * shifts assigned to the same caregiver.
 *
 * Returns an array of conflicting shifts. Empty array means no conflicts.
 *
 * Business rules:
 *   - Only shifts with BLOCKING_STATUSES are considered.
 *   - Shifts whose ID matches `excludeShiftId` are ignored (used when
 *     updating an existing shift — we don't want it to conflict with itself).
 *   - Same-client back-to-back shifts are allowed (no travel time needed).
 *   - Different-client shifts need `travelBufferMinutes` of gap on the
 *     side facing the proposed shift.
 *   - Cancelled, completed, no_show, open, offered shifts never conflict.
 *
 * @param {object}   proposed              { start_time, end_time, client_id }
 * @param {object[]} existingShifts        All shifts assigned to the caregiver
 * @param {object}   options
 * @param {number}   [options.travelBufferMinutes=30]
 * @param {string}   [options.excludeShiftId]  ID to skip (for updates)
 * @returns {object[]}  Conflicting existing shifts (possibly empty)
 */
export function detectConflicts(proposed, existingShifts, options = {}) {
  const {
    travelBufferMinutes = DEFAULT_TRAVEL_BUFFER_MINUTES,
    excludeShiftId = null,
  } = options;

  if (!proposed || !Array.isArray(existingShifts)) return [];
  if (existingShifts.length === 0) return [];

  const proposedStart = toMs(proposed.start_time);
  const proposedEnd = toMs(proposed.end_time);
  const bufferMs = travelBufferMinutes * 60 * 1000;

  const conflicts = [];

  for (const existing of existingShifts) {
    if (!existing) continue;
    if (excludeShiftId && existing.id === excludeShiftId) continue;
    if (!BLOCKING_STATUSES.has(existing.status)) continue;
    if (!existing.start_time || !existing.end_time) continue;

    const { start, end } = expandWithBuffer(existing, proposed, bufferMs);
    if (rangesOverlap(proposedStart, proposedEnd, start, end)) {
      conflicts.push(existing);
    }
  }

  return conflicts;
}

/**
 * Convenience wrapper: boolean version of detectConflicts.
 *
 * @param {object} proposed
 * @param {object[]} existingShifts
 * @param {object} [options]
 * @returns {boolean}  true if any conflict exists
 */
export function hasConflict(proposed, existingShifts, options = {}) {
  return detectConflicts(proposed, existingShifts, options).length > 0;
}
