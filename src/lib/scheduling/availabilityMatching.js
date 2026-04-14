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
// shift's local calendar day. This keeps the function timezone-neutral
// as long as callers use ISO strings consistently.
// ═══════════════════════════════════════════════════════════════

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
 * Parse an ISO date string or Date into components in LOCAL time.
 * Returns { dayOfWeek, minutesOfDay, dateOnly } for matching.
 *   - dayOfWeek: 0 (Sun) .. 6 (Sat) in the browser's local timezone
 *   - minutesOfDay: 0 .. 1439 (local clock)
 *   - dateOnly: 'YYYY-MM-DD' string in local time
 *
 * Why local time: the availability editor stores clock times like
 * '08:00' that the user painted on a visual grid representing their
 * local week. Shifts are created with combineDateAndTimeToIso(),
 * which builds a local Date and serializes to a UTC ISO string —
 * so the ISO string represents a specific local moment. To match
 * a stored "Mon 08:00" availability row against a stored UTC
 * shift, we have to interpret the shift back in local time.
 */
function parseMoment(value) {
  const d = value instanceof Date ? value : new Date(value);
  const dayOfWeek = d.getDay();
  const minutesOfDay = d.getHours() * 60 + d.getMinutes();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return { dayOfWeek, minutesOfDay, dateOnly: `${yyyy}-${mm}-${dd}`, ms: d.getTime() };
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
 * Does a recurring weekly availability row cover [startMoment, endMoment]?
 * Both moments must fall on the same weekday and both within the row's
 * clock-time window. Cross-day shifts are not supported by recurring rows
 * (they'd need two rows or a one-off entry).
 */
function recurringRowCovers(row, startMoment, endMoment) {
  if (row.day_of_week === null || row.day_of_week === undefined) return false;
  if (startMoment.dayOfWeek !== row.day_of_week) return false;
  if (endMoment.dayOfWeek !== row.day_of_week) return false;

  const rowStart = clockToMinutes(row.start_time);
  const rowEnd = clockToMinutes(row.end_time);
  if (rowStart === null || rowEnd === null) return false;

  // Effective window check against the day the shift lands on
  if (!dateWithinRange(startMoment.dateOnly, row.effective_from, row.effective_until)) {
    return false;
  }

  return startMoment.minutesOfDay >= rowStart && endMoment.minutesOfDay <= rowEnd;
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
 * @returns {{ available: boolean, reason: string|null }}
 *
 * Reasons:
 *   - 'no_data'               → no availability rows provided
 *   - 'unavailable_block'     → explicit unavailability row intersects
 *   - 'outside_availability'  → proposed window falls outside all available rows
 *   - null                    → available
 */
export function isAvailable(proposed, availabilityRows) {
  if (!proposed || !proposed.start_time || !proposed.end_time) {
    return { available: false, reason: 'no_data' };
  }
  if (!Array.isArray(availabilityRows) || availabilityRows.length === 0) {
    return { available: false, reason: 'no_data' };
  }

  const startMoment = parseMoment(proposed.start_time);
  const endMoment = parseMoment(proposed.end_time);
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

  // Then: any single available row fully covers → we're good.
  for (const row of availabilityRows) {
    if (!row || row.type !== 'available') continue;
    const covered =
      recurringRowCovers(row, startMoment, endMoment) ||
      oneOffRowCovers(row, startMoment, endMoment);
    if (covered) {
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
 * @returns {object[]} caregivers who are available
 */
export function filterAvailableCaregivers(proposed, caregivers, availabilityByCaregiverId) {
  if (!Array.isArray(caregivers)) return [];
  const map = availabilityByCaregiverId || {};
  return caregivers.filter((cg) => {
    const rows = map[cg.id] || [];
    return isAvailable(proposed, rows).available;
  });
}
