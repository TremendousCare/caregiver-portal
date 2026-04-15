// ═══════════════════════════════════════════════════════════════
// Scheduling — Schedule view helpers (Phase 6)
//
// Pure functions used by CaregiverSchedulePanel and
// ClientSchedulePanel to:
//
//   - Convert caregiver_availability rows into FullCalendar
//     background events so the visible range shows a faint tint
//     where the caregiver is available (green) or unavailable (red).
//
//   - Sum shift hours scheduled in the current week for the
//     hours-this-week counters (caregiver view: "28 hrs scheduled";
//     client view: "18 of 20 planned").
//
//   - Compute gap detection: for a care plan with a target hours
//     per week, how far are we from meeting it this week.
//
// All timestamps are handled in local time to match the rest of
// the scheduling stack (same fix as Phase 4c).
// ═══════════════════════════════════════════════════════════════

// Statuses that consume the caregiver's (or client's) schedule.
// Cancelled / no_show / open / offered shifts don't count.
const BLOCKING_STATUSES = new Set([
  'assigned',
  'confirmed',
  'in_progress',
  'completed',
]);

/**
 * Convert a HH:MM[:SS] string to minutes since local midnight.
 * Returns null for bad input.
 */
function clockToMinutes(clock) {
  if (!clock || typeof clock !== 'string') return null;
  const parts = clock.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Format minutes-since-midnight as "HH:MM:SS".
 */
function minutesToClock(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

/**
 * Generate FullCalendar background events for a caregiver's
 * recurring availability within [windowStart, windowEnd].
 *
 * Recurring availability rows (with day_of_week + start_time +
 * end_time) become one background event per matching day in the
 * window. One-off rows are handled separately by
 * buildOneOffBackgroundEvents().
 *
 * Return value is an array of FullCalendar event objects:
 *   {
 *     id,
 *     start: 'YYYY-MM-DDTHH:MM:SS',   // local-time ISO
 *     end:   'YYYY-MM-DDTHH:MM:SS',
 *     display: 'background',
 *     backgroundColor: green/red,
 *     classNames: ['availability-bg'],
 *   }
 */
export function buildRecurringAvailabilityEvents(availabilityRows, windowStart, windowEnd) {
  if (!Array.isArray(availabilityRows) || availabilityRows.length === 0) return [];
  if (!(windowStart instanceof Date) || !(windowEnd instanceof Date)) return [];
  if (windowEnd.getTime() < windowStart.getTime()) return [];

  const results = [];
  const cursor = new Date(
    windowStart.getFullYear(),
    windowStart.getMonth(),
    windowStart.getDate(),
    0, 0, 0, 0,
  );
  const endExclusive = new Date(
    windowEnd.getFullYear(),
    windowEnd.getMonth(),
    windowEnd.getDate() + 1,
    0, 0, 0, 0,
  );

  while (cursor.getTime() < endExclusive.getTime()) {
    const dow = cursor.getDay();
    const dateStr = formatLocalDate(cursor);
    for (const row of availabilityRows) {
      if (!row) continue;
      // Only recurring rows (with day_of_week) handled here
      if (row.dayOfWeek === null || row.dayOfWeek === undefined) continue;
      if (row.dayOfWeek !== dow) continue;
      // Effective window check
      if (row.effectiveFrom && dateStr < row.effectiveFrom) continue;
      if (row.effectiveUntil && dateStr > row.effectiveUntil) continue;
      const startMins = clockToMinutes(row.startTime);
      const endMins = clockToMinutes(row.endTime);
      if (startMins === null || endMins === null || endMins <= startMins) continue;

      const isAvailable = row.type !== 'unavailable';
      results.push({
        id: `avail-${row.id}-${dateStr}`,
        start: `${dateStr}T${minutesToClock(startMins)}`,
        end: `${dateStr}T${minutesToClock(endMins)}`,
        display: 'background',
        backgroundColor: isAvailable ? 'rgba(74, 222, 128, 0.25)' : 'rgba(248, 113, 113, 0.35)',
        classNames: isAvailable ? ['availability-bg', 'availability-bg-available'] : ['availability-bg', 'availability-bg-unavailable'],
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return results;
}

/**
 * Generate FullCalendar background events for one-off (date-range)
 * availability rows (vacation, sick days, specific blocked days).
 */
export function buildOneOffBackgroundEvents(availabilityRows, windowStart, windowEnd) {
  if (!Array.isArray(availabilityRows) || availabilityRows.length === 0) return [];
  if (!(windowStart instanceof Date) || !(windowEnd instanceof Date)) return [];

  const windowStartStr = formatLocalDate(windowStart);
  const windowEndStr = formatLocalDate(windowEnd);

  const results = [];
  for (const row of availabilityRows) {
    if (!row) continue;
    if (row.dayOfWeek !== null && row.dayOfWeek !== undefined) continue; // skip recurring
    if (!row.startDate) continue;
    const rowStart = row.startDate;
    const rowEnd = row.endDate || row.startDate;
    // Skip if entirely outside the window
    if (rowEnd < windowStartStr || rowStart > windowEndStr) continue;

    const isAvailable = row.type !== 'unavailable';
    // If explicit clock times are set, use them; otherwise cover the
    // full day(s). For multi-day ranges with no clock times, we emit
    // one all-day background event spanning start to end+1.
    const startClock = clockToMinutes(row.startTime);
    const endClock = clockToMinutes(row.endTime);

    if (startClock === null || endClock === null) {
      // Full day(s)
      const nextDay = addDaysStr(rowEnd, 1);
      results.push({
        id: `avail-oneoff-${row.id}`,
        start: rowStart,
        end: nextDay,
        display: 'background',
        backgroundColor: isAvailable ? 'rgba(74, 222, 128, 0.25)' : 'rgba(248, 113, 113, 0.35)',
        classNames: isAvailable ? ['availability-bg', 'availability-bg-available'] : ['availability-bg', 'availability-bg-unavailable'],
      });
    } else if (rowStart === rowEnd) {
      // Same-day with explicit hours
      results.push({
        id: `avail-oneoff-${row.id}`,
        start: `${rowStart}T${minutesToClock(startClock)}`,
        end: `${rowStart}T${minutesToClock(endClock)}`,
        display: 'background',
        backgroundColor: isAvailable ? 'rgba(74, 222, 128, 0.25)' : 'rgba(248, 113, 113, 0.35)',
        classNames: isAvailable ? ['availability-bg', 'availability-bg-available'] : ['availability-bg', 'availability-bg-unavailable'],
      });
    }
    // Multi-day with explicit clock times is skipped (we don't
    // currently expand those into per-day background events).
  }
  return results;
}

/**
 * Add `days` to a YYYY-MM-DD string, returning the new YYYY-MM-DD.
 */
function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return formatLocalDate(dt);
}

/**
 * Format a Date as YYYY-MM-DD in local time.
 */
function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Compute the Sunday-Saturday week bounds (local time) containing
 * a given reference date.
 */
export function weekBoundsContainingLocal(refDate) {
  const d = refDate instanceof Date ? refDate : new Date(refDate);
  if (Number.isNaN(d.getTime())) return null;
  const dayOfWeek = d.getDay();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dayOfWeek, 0, 0, 0, 0);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

/**
 * Sum shift hours that fall within [windowStart, windowEnd] AND
 * have a blocking status. Clips shifts that straddle the window.
 * Used for the "hours scheduled this week" counters.
 */
export function sumShiftHoursInWindow(shifts, windowStart, windowEnd) {
  if (!Array.isArray(shifts) || shifts.length === 0) return 0;
  const ws = windowStart instanceof Date ? windowStart.getTime() : new Date(windowStart).getTime();
  const we = windowEnd instanceof Date ? windowEnd.getTime() : new Date(windowEnd).getTime();
  let totalMs = 0;
  for (const shift of shifts) {
    if (!shift || !shift.startTime || !shift.endTime) continue;
    if (!BLOCKING_STATUSES.has(shift.status)) continue;
    const start = new Date(shift.startTime).getTime();
    const end = new Date(shift.endTime).getTime();
    const clippedStart = Math.max(start, ws);
    const clippedEnd = Math.min(end, we);
    if (clippedEnd > clippedStart) totalMs += clippedEnd - clippedStart;
  }
  return totalMs / (60 * 60 * 1000);
}

/**
 * Count shift status breakdown for the hours-this-week footer.
 * Returns: { total, confirmed, assigned, inProgress, completed, open, offered, cancelled, noShow }
 */
export function countShiftsByStatus(shifts) {
  const counts = {
    total: 0,
    confirmed: 0,
    assigned: 0,
    inProgress: 0,
    completed: 0,
    open: 0,
    offered: 0,
    cancelled: 0,
    noShow: 0,
  };
  if (!Array.isArray(shifts)) return counts;
  for (const shift of shifts) {
    if (!shift) continue;
    counts.total++;
    switch (shift.status) {
      case 'confirmed': counts.confirmed++; break;
      case 'assigned': counts.assigned++; break;
      case 'in_progress': counts.inProgress++; break;
      case 'completed': counts.completed++; break;
      case 'open': counts.open++; break;
      case 'offered': counts.offered++; break;
      case 'cancelled': counts.cancelled++; break;
      case 'no_show': counts.noShow++; break;
      default: break;
    }
  }
  return counts;
}

/**
 * Compute the total weekly target hours across a client's active
 * care plans. Used by the client schedule view's gap counter.
 */
export function sumActivePlanHours(carePlans) {
  if (!Array.isArray(carePlans)) return 0;
  let total = 0;
  for (const plan of carePlans) {
    if (!plan || plan.status !== 'active') continue;
    if (typeof plan.hoursPerWeek === 'number' && plan.hoursPerWeek > 0) {
      total += plan.hoursPerWeek;
    }
  }
  return total;
}

/**
 * Build a short human-readable progress string comparing scheduled
 * hours against planned hours.
 *
 * Examples:
 *   "18 hrs scheduled"                     (no plan target)
 *   "18 of 20 hrs scheduled"               (under target)
 *   "20 hrs scheduled (meets plan)"        (at or over target)
 *   "0 of 20 hrs scheduled (unfilled)"     (nothing yet, has target)
 */
export function formatScheduledVsPlanned(scheduledHours, plannedHours) {
  const scheduled = Math.round((scheduledHours || 0) * 10) / 10;
  if (!plannedHours || plannedHours <= 0) {
    return `${scheduled} hrs scheduled`;
  }
  if (scheduled === 0) {
    return `0 of ${plannedHours} hrs scheduled (unfilled)`;
  }
  if (scheduled >= plannedHours) {
    return `${scheduled} hrs scheduled (meets plan)`;
  }
  return `${scheduled} of ${plannedHours} hrs scheduled`;
}
