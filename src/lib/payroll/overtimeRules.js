// CA Overtime classification.
//
// Pure function: takes a list of shifts + a workweek anchor + a
// jurisdiction + a timezone, returns the regular/overtime/double-time
// breakdown for the week — totals plus a per-shift split that the
// timesheet builder turns into `timesheet_shifts` rows.
//
// California rules implemented (per CA Labor Code §510 + DLSE):
//   - Daily hours 0..8        → regular
//   - Daily hours 8..12       → overtime (1.5x)
//   - Daily hours 12+         → double time (2.0x)
//   - 7th consecutive day worked in the workweek:
//         hours 0..8          → overtime (1.5x)
//         hours 8+            → double time (2.0x)
//   - Weekly cap: hours classified as "regular" above hour 40 of the
//     workweek are reclassified as overtime (1.5x). The first 40 reg
//     hours of the week in chronological order stay regular; anything
//     after that becomes OT. Hours already classified daily as OT/DT
//     are NOT double-counted by the weekly rule.
//
// The engine takes a `jurisdiction` parameter from day one even though
// only `CA` is implemented. Other values throw a clear error so a
// future migration to multi-state is a code change, not a silent
// mis-classification.
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   ("CA overtime rules", "Phase 3 — Timesheet generation and overtime engine").

import {
  CA_DAILY_DOUBLE_TIME_THRESHOLD_HOURS,
  CA_DAILY_REGULAR_HOURS,
  CA_WEEKLY_REGULAR_HOURS,
  DEFAULT_OT_JURISDICTION,
  DEFAULT_PAYROLL_TIMEZONE,
  SUPPORTED_OT_JURISDICTIONS,
} from './constants.js';
import {
  utcMsToWallClockParts,
  wallClockToUtcMs,
} from '../scheduling/timezone.js';

// Floating-point rounding helper. Hours are stored to 2 decimal places
// in the DB; keeping engine arithmetic at the same precision avoids
// "0.30000000000000004" rounding artifacts surfacing in test
// assertions and totals.
function round2(value) {
  return Math.round(value * 100) / 100;
}

function toMs(value, fieldName) {
  if (value instanceof Date) {
    const t = value.getTime();
    if (Number.isNaN(t)) {
      throw new Error(`overtimeRules: ${fieldName} is an invalid Date`);
    }
    return t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const t = new Date(value).getTime();
    if (Number.isNaN(t)) {
      throw new Error(`overtimeRules: ${fieldName} is not a parseable date string (got "${value}")`);
    }
    return t;
  }
  throw new Error(`overtimeRules: ${fieldName} is required`);
}

/**
 * Build the ordered list of dayIso strings comprising a 7-day workweek
 * starting at `weekStart` in the configured timezone. Walking
 * day-by-day via wall-clock math keeps DST transitions (which add or
 * remove an hour to a single day) from shifting the date boundary.
 */
function buildWorkweekDays(weekStart, timezone) {
  let anchorMs;
  if (weekStart instanceof Date) {
    if (Number.isNaN(weekStart.getTime())) {
      throw new Error('overtimeRules: weekStart is an invalid Date');
    }
    anchorMs = weekStart.getTime();
  } else if (typeof weekStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    const [y, m, d] = weekStart.split('-').map(Number);
    anchorMs = wallClockToUtcMs({ year: y, month: m, day: d }, timezone);
  } else if (typeof weekStart === 'string' && weekStart.length > 0) {
    const t = new Date(weekStart).getTime();
    if (Number.isNaN(t)) {
      throw new Error(`overtimeRules: weekStart is not parseable (got "${weekStart}")`);
    }
    anchorMs = t;
  } else {
    throw new Error('overtimeRules: weekStart is required');
  }

  const days = [];
  let cursorMs = anchorMs;
  for (let i = 0; i < 7; i += 1) {
    const parts = utcMsToWallClockParts(cursorMs, timezone);
    days.push({ position: i, dayIso: parts.dateOnly });
    cursorMs = wallClockToUtcMs(
      { year: parts.year, month: parts.month, day: parts.day + 1 },
      timezone,
    );
  }
  return days;
}

/**
 * Split one shift into per-day segments, where each segment sits
 * entirely within a single calendar day in the configured timezone.
 * Returns an empty array for zero-or-negative-duration shifts (the
 * caller — usually the timesheet builder — has already decided
 * whether to flag missing-clock-out as an exception).
 */
function splitShiftIntoDaySegments(shift, timezone) {
  const startMs = toMs(shift.startTime, `shift[${shift.id}].startTime`);
  const endMs = toMs(shift.endTime, `shift[${shift.id}].endTime`);
  if (endMs <= startMs) return [];

  const segments = [];
  let cursorMs = startMs;
  // Defensive cap on iterations — a malformed shift should never need
  // more than ~10 day-segments and we never want to spin forever.
  let iterations = 0;
  while (cursorMs < endMs && iterations < 30) {
    iterations += 1;
    const parts = utcMsToWallClockParts(cursorMs, timezone);
    const nextMidnightMs = wallClockToUtcMs(
      { year: parts.year, month: parts.month, day: parts.day + 1 },
      timezone,
    );
    const segmentEndMs = Math.min(nextMidnightMs, endMs);
    const hours = (segmentEndMs - cursorMs) / 3_600_000;
    if (hours > 0) {
      segments.push({
        shiftId: shift.id,
        dayIso: parts.dateOnly,
        startMs: cursorMs,
        endMs: segmentEndMs,
        hours,
      });
    }
    cursorMs = segmentEndMs;
  }
  return segments;
}

/**
 * Apply CA daily classification for a single day's total hours.
 * Returns { regular, overtime, doubleTime } with the daily breakdown.
 */
function classifyCaDay(totalHours, isSeventhConsecutiveDay) {
  if (totalHours <= 0) return { regular: 0, overtime: 0, doubleTime: 0 };

  if (isSeventhConsecutiveDay) {
    const overtime = Math.min(totalHours, CA_DAILY_REGULAR_HOURS);
    const doubleTime = Math.max(totalHours - CA_DAILY_REGULAR_HOURS, 0);
    return { regular: 0, overtime, doubleTime };
  }

  const regular = Math.min(totalHours, CA_DAILY_REGULAR_HOURS);
  const overtime = Math.min(
    Math.max(totalHours - CA_DAILY_REGULAR_HOURS, 0),
    CA_DAILY_DOUBLE_TIME_THRESHOLD_HOURS - CA_DAILY_REGULAR_HOURS,
  );
  const doubleTime = Math.max(totalHours - CA_DAILY_DOUBLE_TIME_THRESHOLD_HOURS, 0);
  return { regular, overtime, doubleTime };
}

/**
 * Walk the day map in workweek order and bump regular hours past the
 * 40h weekly cap into overtime, in chronological order. Mutates the
 * passed daily breakdown. Hours already classified as OT/DT under the
 * daily rule are NOT touched — they don't double-count toward the
 * weekly cap.
 */
function applyWeeklyCap(workweekDays, dailyBreakdown) {
  let runningRegular = 0;
  for (const { dayIso } of workweekDays) {
    const day = dailyBreakdown.get(dayIso);
    if (!day || day.regular <= 0) continue;
    const after = runningRegular + day.regular;
    if (after <= CA_WEEKLY_REGULAR_HOURS) {
      runningRegular = after;
      continue;
    }
    // Move (after - 40) hours from regular → overtime, capped at the
    // day's regular total (a day with 8 reg can't lose 12).
    const toMove = Math.min(after - CA_WEEKLY_REGULAR_HOURS, day.regular);
    day.regular -= toMove;
    day.overtime += toMove;
    runningRegular = CA_WEEKLY_REGULAR_HOURS;
  }
}

/**
 * Within a single day, distribute the day's classified reg/ot/dt
 * hours back to the day's segments in chronological order. The first
 * hours of the day fill `regular`, then `overtime`, then `doubleTime`.
 */
function distributeDayToSegments(segments, daily) {
  let regLeft = daily.regular;
  let otLeft = daily.overtime;
  let dtLeft = daily.doubleTime;
  return segments.map((seg) => {
    let remaining = seg.hours;
    const r = Math.min(remaining, regLeft);
    regLeft -= r;
    remaining -= r;
    const o = Math.min(remaining, otLeft);
    otLeft -= o;
    remaining -= o;
    const d = Math.min(remaining, dtLeft);
    dtLeft -= d;
    remaining -= d;
    return {
      ...seg,
      regular: r,
      overtime: o,
      doubleTime: d,
    };
  });
}

/**
 * Classify a workweek of shifts into regular / overtime / double-time
 * hours under the CA jurisdiction's rules.
 *
 * @param {object} args
 * @param {Array<{id: string, startTime: Date|string, endTime: Date|string}>} args.shifts
 *   Shifts the caregiver worked. The OT engine doesn't read clock_events
 *   directly — the timesheet builder is responsible for choosing
 *   start/end (typically clock-in/out times). Shifts with end <= start
 *   are silently dropped (zero duration); the timesheet builder is
 *   responsible for the missing-clock-out exception.
 * @param {Date|string} args.weekStart
 *   First day of the workweek (Monday in the configured timezone).
 *   Accepts a Date or a YYYY-MM-DD string.
 * @param {string} [args.jurisdiction]
 *   Jurisdiction key. v1 only implements 'CA'; other values throw.
 * @param {string} [args.timezone]
 *   IANA timezone for day-boundary determination. Defaults to
 *   America/Los_Angeles when the caller omits one.
 *
 * @returns {{
 *   regular: number,
 *   overtime: number,
 *   doubleTime: number,
 *   byShift: Array<{
 *     shiftId: string,
 *     regular: number,
 *     overtime: number,
 *     doubleTime: number,
 *     totalHours: number,
 *   }>,
 *   byDay: Array<{
 *     dayIso: string,
 *     position: number,
 *     totalHours: number,
 *     regular: number,
 *     overtime: number,
 *     doubleTime: number,
 *     isSeventhConsecutiveDay: boolean,
 *   }>,
 * }}
 */
export function classifyHours({
  shifts,
  weekStart,
  jurisdiction = DEFAULT_OT_JURISDICTION,
  timezone = DEFAULT_PAYROLL_TIMEZONE,
}) {
  if (!SUPPORTED_OT_JURISDICTIONS.includes(jurisdiction)) {
    throw new Error(
      `overtimeRules: jurisdiction "${jurisdiction}" is not supported in v1. ` +
        `Only ${SUPPORTED_OT_JURISDICTIONS.join(', ')} is implemented. ` +
        `Add the new jurisdiction to SUPPORTED_OT_JURISDICTIONS and a branch in classifyHours.`,
    );
  }
  if (!Array.isArray(shifts)) {
    throw new Error('overtimeRules: shifts must be an array');
  }

  const tz = timezone || DEFAULT_PAYROLL_TIMEZONE;
  const workweekDays = buildWorkweekDays(weekStart, tz);
  const validDayIsos = new Set(workweekDays.map((d) => d.dayIso));

  // ── 1. Split each shift into per-day segments ──
  const allSegments = [];
  for (const shift of shifts) {
    if (!shift || !shift.id) {
      throw new Error('overtimeRules: every shift requires a non-empty id');
    }
    const segments = splitShiftIntoDaySegments(shift, tz);
    for (const seg of segments) {
      if (!validDayIsos.has(seg.dayIso)) {
        // Shift segment falls outside the workweek (the caller passed
        // a shift that bleeds into prior/next week). We deliberately
        // ignore those hours rather than mis-attribute them to the
        // current week's totals — the timesheet builder is responsible
        // for week-bounded queries.
        continue;
      }
      allSegments.push(seg);
    }
  }

  // ── 2. Group segments by day, sorted chronologically within day ──
  const segmentsByDay = new Map();
  for (const seg of allSegments) {
    if (!segmentsByDay.has(seg.dayIso)) segmentsByDay.set(seg.dayIso, []);
    segmentsByDay.get(seg.dayIso).push(seg);
  }
  for (const [, segs] of segmentsByDay) {
    segs.sort((a, b) => a.startMs - b.startMs);
  }

  // ── 3. Compute total hours per day ──
  const dailyBreakdown = new Map();
  for (const { dayIso } of workweekDays) {
    const segs = segmentsByDay.get(dayIso) || [];
    const totalHours = segs.reduce((sum, s) => sum + s.hours, 0);
    dailyBreakdown.set(dayIso, {
      dayIso,
      totalHours,
      regular: 0,
      overtime: 0,
      doubleTime: 0,
      isSeventhConsecutiveDay: false,
    });
  }

  // ── 4. Determine the 7th-consecutive-day flag ──
  // The rule fires only if every prior day in the workweek (positions
  // 0..5) has hours > 0 AND the 7th day (position 6) itself has hours.
  const sundayDayIso = workweekDays[6].dayIso;
  const sundayDay = dailyBreakdown.get(sundayDayIso);
  const priorSixWorked = workweekDays
    .slice(0, 6)
    .every(({ dayIso }) => (dailyBreakdown.get(dayIso)?.totalHours ?? 0) > 0);
  if (priorSixWorked && sundayDay && sundayDay.totalHours > 0) {
    sundayDay.isSeventhConsecutiveDay = true;
  }

  // ── 5. Daily classification ──
  for (const day of dailyBreakdown.values()) {
    const { regular, overtime, doubleTime } = classifyCaDay(
      day.totalHours,
      day.isSeventhConsecutiveDay,
    );
    day.regular = regular;
    day.overtime = overtime;
    day.doubleTime = doubleTime;
  }

  // ── 6. Weekly 40h cap ──
  applyWeeklyCap(workweekDays, dailyBreakdown);

  // ── 7. Distribute each day's classified hours to its segments ──
  const classifiedSegments = [];
  for (const { dayIso } of workweekDays) {
    const segs = segmentsByDay.get(dayIso) || [];
    if (segs.length === 0) continue;
    const day = dailyBreakdown.get(dayIso);
    classifiedSegments.push(...distributeDayToSegments(segs, day));
  }

  // ── 8. Aggregate per-shift ──
  const byShiftMap = new Map();
  for (const seg of classifiedSegments) {
    const existing = byShiftMap.get(seg.shiftId) || {
      shiftId: seg.shiftId,
      regular: 0,
      overtime: 0,
      doubleTime: 0,
      totalHours: 0,
    };
    existing.regular += seg.regular;
    existing.overtime += seg.overtime;
    existing.doubleTime += seg.doubleTime;
    existing.totalHours += seg.hours;
    byShiftMap.set(seg.shiftId, existing);
  }

  const byShift = Array.from(byShiftMap.values()).map((row) => ({
    shiftId: row.shiftId,
    regular: round2(row.regular),
    overtime: round2(row.overtime),
    doubleTime: round2(row.doubleTime),
    totalHours: round2(row.totalHours),
  }));

  const byDay = workweekDays.map(({ dayIso, position }) => {
    const d = dailyBreakdown.get(dayIso);
    return {
      dayIso,
      position,
      totalHours: round2(d.totalHours),
      regular: round2(d.regular),
      overtime: round2(d.overtime),
      doubleTime: round2(d.doubleTime),
      isSeventhConsecutiveDay: d.isSeventhConsecutiveDay,
    };
  });

  // Totals computed from rounded daily values so per-shift, per-day,
  // and aggregate totals all agree to the cent.
  const regularTotal = round2(byDay.reduce((s, d) => s + d.regular, 0));
  const overtimeTotal = round2(byDay.reduce((s, d) => s + d.overtime, 0));
  const doubleTimeTotal = round2(byDay.reduce((s, d) => s + d.doubleTime, 0));

  return {
    regular: regularTotal,
    overtime: overtimeTotal,
    doubleTime: doubleTimeTotal,
    byShift,
    byDay,
  };
}
