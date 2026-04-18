// ═══════════════════════════════════════════════════════════════
// Scheduling — Availability Matching
//
// Pure functions for determining whether a caregiver's stored
// availability rows cover a proposed shift time window.
//
// Availability rows come in two modes:
//
//   1. Recurring weekly
//      - day_of_week (0=Sun, 6=Sat)
//      - start_time / end_time  (HH:MM[:SS], local clock time)
//      - optional effective_from / effective_until window
//      - type: 'available' or 'unavailable'
//
//   2. One-off date range
//      - start_date / end_date
//      - optional start_time / end_time to limit the range to certain hours
//      - type: 'available' or 'unavailable'
//
// Matching rules:
//   - A proposed shift is "covered" only if the FULL window is covered
//     by one or more AVAILABLE rows (partial overlap → not available).
//   - Any UNAVAILABLE row intersecting the proposed window disqualifies it.
//   - If no rows apply → not available (safe default: no data = no go).
//
// All times are handled in UTC milliseconds for comparison, and clock
// times (start_time / end_time) are interpreted against the proposed
// shift's calendar day in the `timezone` option (see ./timezone.js).
// Production callers should pass DEFAULT_APP_TIMEZONE explicitly;
// omitting it falls back to the JS runtime's local zone for legacy
// compatibility.
// ═══════════════════════════════════════════════════════════════

import { utcMsToWallClockParts } from './timezone';

/**
 * Parse a "HH:MM" or "HH:MM:SS" clock string into minutes-from-midnight.
 * Returns null for missing/invalid input.
 */
function clockToMinutes(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Parse an ISO date string or Date into wall-clock components as seen
 * in the caller-provided `timezone` (falling back to the runtime's
 * local zone). Returns { dayOfWeek, minutesOfDay, dateOnly, ms } for
 * matching against availability rows.
 *
 * Why a specific timezone: the availability editor stores clock times
 * like '08:00' that the user painted on a visual grid representing a
 * specific week in a specific zone. To match "Mon 08:00 PT" against a
 * UTC ISO shift timestamp, we must decompose the ISO in that same
 * zone. Using the JS runtime's local zone (the legacy default) makes
 * the check runtime-dependent and DST-fragile.
 */
function parseMoment(value, timezone) {
  const parts = utcMsToWallClockParts(value, timezone);
  return {
    dayOfWeek: parts.dayOfWeek,
    minutesOfDay: parts.minutesOfDay,
    dateOnly: parts.dateOnly,
    ms: parts.ms,
  };
}

/**
 * Is `dateOnly` (YYYY-MM-DD) within [effective_from, effective_until]?
 * Null bounds mean open-ended.
 */
function dateWithinRange(dateOnly, from, until) {
  if (from && dateOnly < from) return false;
  if (until && dateOnly > until) return false;
  return true;
}

/**
 * Does a recurring row intersect [startMoment, endMoment]? (for unavailability check)
 */
function recurringRowIntersects(row, startMoment, endMoment) {
  if (row.day_of_week === null || row.day_of_week === undefined) return false;
  if (startMoment.dayOfWeek !== row.day_of_week) return false;

  const rowStart = clockToMinutes(row.start_time);
  const rowEnd = clockToMinutes(row.end_time);
  if (rowStart === null || rowEnd === null) return false;

  if (!dateWithinRange(startMoment.dateOnly, row.effective_from, row.effective_until)) {
    return false;
  }

  return startMoment.minutesOfDay < rowEnd && endMoment.minutesOfDay > rowStart;
}

/**
 * Does a one-off date range row cover [startMoment, endMoment]?
 * If the row has start_time/end_time, the shift must also fall within
 * those hours on each day within the range.
 */
function oneOffRowCovers(row, startMoment, endMoment) {
  if (!row.start_date) return false;
  const startDate = row.start_date;
  const endDate = row.end_date || row.start_date;

  if (startMoment.dateOnly < startDate || endMoment.dateOnly > endDate) return false;

  // If no hours are specified, the whole day is considered covered
  const rowStart = clockToMinutes(row.start_time);
  const rowEnd = clockToMinutes(row.end_time);
  if (rowStart === null || rowEnd === null) return true;

  // For multi-day ranges with hours, we conservatively say it only covers
  // single-day shifts within the row's hour window.
  if (startMoment.dateOnly !== endMoment.dateOnly) return false;
  return startMoment.minutesOfDay >= rowStart && endMoment.minutesOfDay <= rowEnd;
}

/**
 * Collect every AVAILABLE clock-minute interval that applies to the
 * shift's calendar day. Used to fix the "adjacent rows don't cover"
 * bug: a shift 08:00-16:00 that split availability as 08:00-12:00 +
 * 12:00-16:00 used to be rejected because no single row covered it.
 * By unioning applicable intervals first, back-to-back (and overlapping)
 * rows combine correctly.
 *
 * Only called for same-day shifts. Multi-day shifts fall back to the
 * legacy per-row `oneOffRowCovers` path for whole-day coverage.
 */
function availableIntervalsOnDay(rows, startMoment, endMoment) {
  const intervals = [];
  for (const row of rows) {
    if (!row || row.type !== 'available') continue;

    // Recurring weekly row matching this weekday
    if (row.day_of_week !== null && row.day_of_week !== undefined) {
      if (row.day_of_week !== startMoment.dayOfWeek) continue;
      if (
        !dateWithinRange(startMoment.dateOnly, row.effective_from, row.effective_until)
      ) {
        continue;
      }
      const rs = clockToMinutes(row.start_time);
      const re = clockToMinutes(row.end_time);
      if (rs === null || re === null) continue;
      intervals.push([rs, re]);
      continue;
    }

    // One-off date-range row covering this date
    if (row.start_date) {
      const rowStartDate = row.start_date;
      const rowEndDate = row.end_date || row.start_date;
      if (startMoment.dateOnly < rowStartDate || endMoment.dateOnly > rowEndDate) {
        continue;
      }
      const rs = clockToMinutes(row.start_time);
      const re = clockToMinutes(row.end_time);
      if (rs === null || re === null) {
        // No hours → the whole day is covered.
        intervals.push([0, 24 * 60]);
      } else {
        intervals.push([rs, re]);
      }
    }
  }
  return intervals;
}

/**
 * Merge a list of [start, end] minute intervals. Touching intervals
 * (a.end === b.start) are coalesced too — that's the whole point of
 * this fix, so back-to-back availability rows count as continuous
 * coverage.
 */
function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      out.push(cur.slice());
    }
  }
  return out;
}

/**
 * Is [start, end] fully inside one of the merged intervals?
 */
function intervalsContain(merged, start, end) {
  return merged.some(([a, b]) => a <= start && b >= end);
}

/**
 * Does a one-off row intersect [startMoment, endMoment]? (for unavailability check)
 */
function oneOffRowIntersects(row, startMoment, endMoment) {
  if (!row.start_date) return false;
  const startDate = row.start_date;
  const endDate = row.end_date || row.start_date;

  // No date overlap at all?
  if (endMoment.dateOnly < startDate || startMoment.dateOnly > endDate) return false;

  // If no clock times, the entire day range is blocked
  const rowStart = clockToMinutes(row.start_time);
  const rowEnd = clockToMinutes(row.end_time);
  if (rowStart === null || rowEnd === null) return true;

  // With clock times: only intersect if the shift is on a day in the range
  // AND its clock window overlaps the row's clock window. For simplicity we
  // only check same-day shifts here — multi-day shifts with hour-limited
  // blocks would need more nuanced handling but aren't part of Phase 2.
  if (startMoment.dateOnly !== endMoment.dateOnly) return false;
  return startMoment.minutesOfDay < rowEnd && endMoment.minutesOfDay > rowStart;
}

/**
 * Is a caregiver available for the given proposed time window?
 *
 * @param {object}   proposed               { start_time, end_time } ISO strings or Dates
 * @param {object[]} availabilityRows       Rows from caregiver_availability
 * @param {{ timezone?: string }} [options]
 *   `timezone` is an IANA zone (e.g. 'America/Los_Angeles'). Production
 *   callers should pass DEFAULT_APP_TIMEZONE from `./timezone`. Omit
 *   to use the JS runtime's local zone (legacy behavior).
 * @returns {{ available: boolean, reason: string|null }}
 *
 * Reasons:
 *   - 'no_data'               → no availability rows provided
 *   - 'unavailable_block'     → explicit unavailability row intersects
 *   - 'outside_availability'  → proposed window falls outside all available rows
 *   - null                    → available
 */
export function isAvailable(proposed, availabilityRows, options = {}) {
  if (!proposed || !proposed.start_time || !proposed.end_time) {
    return { available: false, reason: 'no_data' };
  }
  if (!Array.isArray(availabilityRows) || availabilityRows.length === 0) {
    return { available: false, reason: 'no_data' };
  }

  const { timezone } = options;
  const startMoment = parseMoment(proposed.start_time, timezone);
  const endMoment = parseMoment(proposed.end_time, timezone);
  if (endMoment.ms <= startMoment.ms) {
    return { available: false, reason: 'no_data' };
  }

  // First: check for any intersecting 'unavailable' row — those always win.
  for (const row of availabilityRows) {
    if (!row || row.type !== 'unavailable') continue;
    const hits =
      recurringRowIntersects(row, startMoment, endMoment) ||
      oneOffRowIntersects(row, startMoment, endMoment);
    if (hits) {
      return { available: false, reason: 'unavailable_block' };
    }
  }

  // Same-day shifts: union all applicable available intervals and
  // check whether the shift is inside the merged coverage. This lets
  // adjacent rows (08:00-12:00 + 12:00-16:00) cover a single 08:00-
  // 16:00 shift, which was impossible under the old per-row check.
  if (startMoment.dateOnly === endMoment.dateOnly) {
    const merged = mergeIntervals(
      availableIntervalsOnDay(availabilityRows, startMoment, endMoment),
    );
    if (intervalsContain(merged, startMoment.minutesOfDay, endMoment.minutesOfDay)) {
      return { available: true, reason: null };
    }
    return { available: false, reason: 'outside_availability' };
  }

  // Multi-day shift: fall back to the legacy per-row check. Only one-
  // off rows without hour restrictions can cover multi-day shifts
  // (recurring rows are same-weekday only).
  for (const row of availabilityRows) {
    if (!row || row.type !== 'available') continue;
    if (oneOffRowCovers(row, startMoment, endMoment)) {
      return { available: true, reason: null };
    }
  }

  return { available: false, reason: 'outside_availability' };
}

/**
 * Filter a list of caregivers down to those available for a given shift.
 *
 * @param {object}   proposed                  { start_time, end_time }
 * @param {object[]} caregivers                Each must have an `id`
 * @param {object}   availabilityByCaregiverId Map: caregiverId → rows[]
 * @param {{ timezone?: string }} [options]    Forwarded to `isAvailable`.
 * @returns {object[]} caregivers who are available
 */
export function filterAvailableCaregivers(
  proposed,
  caregivers,
  availabilityByCaregiverId,
  options = {},
) {
  if (!Array.isArray(caregivers)) return [];
  const map = availabilityByCaregiverId || {};
  return caregivers.filter((cg) => {
    const rows = map[cg.id] || [];
    return isAvailable(proposed, rows, options).available;
  });
}
