// Timesheet builder — pure function.
//
// Given a caregiver_id, a workweek window, and the caregiver's shifts +
// clock_events for that week, produce a draft `timesheets` row plus
// `timesheet_shifts` junction rows. NO database writes; the Phase 3
// edge function (`payroll-generate-timesheets`) handles persistence.
//
// Design choices worth highlighting:
//
//  - Hours come from clock_events when present, scheduled times
//    otherwise. The first clock-in is the shift start, the last
//    clock-out is the shift end. Multiple in/out pairs (paid breaks)
//    are NOT subtracted in v1 — TC currently treats breaks as paid.
//    Phase 4's UI lets back office adjust if needed.
//
//  - A shift that overlaps the workweek's boundary (e.g. starts Sun
//    11pm, ends Mon 3am) is included on BOTH weeks' timesheets. The
//    OT engine counts only the in-week portion of the shift's hours;
//    the timesheet_shifts row's `hours_worked` is the in-week portion
//    only. The same shift_id appears on two timesheets (different
//    timesheet_ids) — this is allowed by the junction's PK
//    (timesheet_id, shift_id).
//
//  - `timesheet_shifts.hour_classification` is a single text value
//    per row (CHECK constraint). A shift that spans multiple classes
//    (8h reg + 2h OT) is recorded as its DOMINANT class, ties broken
//    in the order regular → overtime → double_time. This is a known
//    v1 limitation; future per-class hour columns would replace the
//    dominant-class encoding.
//
//  - Gross pay is per-shift: each shift contributes
//        Σ (regular_seg × shift_rate) + OT premium (CA weighted ROP)
//          + DT premium (CA weighted ROP)
//    so a workweek with mixed rates pays correctly without forcing the
//    back office to reconcile to a single rate. The CA weighted ROP is
//    used for the 0.5×/1.0× premium portions per DLSE Opinion Letter
//    2002.12.09-2; when every shift carries the same rate the math
//    reduces to base × hours × multiplier. Phase 4 PR #2.
//
//  - When the week has no shifts and no mileage, the builder returns
//    null. The caller skips empty weeks entirely (no DB row created).
//
// Plan reference:
//   docs/plans/2026-04-25-paychex-integration-plan.md
//   ("Phase 3 — Timesheet generation and overtime engine").
//   docs/handoff-paychex-phase-4.md ("Per-shift rates — deferred to Phase 4").

import { HOUR_CLASSIFICATION } from './constants.js';
import { classifyHours, computeRegularRateOfPay } from './overtimeRules.js';
import {
  utcMsToWallClockParts,
  wallClockToUtcMs,
} from '../scheduling/timezone.js';

function round2(value) {
  return Math.round(value * 100) / 100;
}

function toMs(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'string' && value.length > 0) {
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/**
 * Resolve a date-or-Date input to YYYY-MM-DD in the configured tz.
 * Used for writing the pay_period_start/end values; the DB columns
 * are `date`, not `timestamptz`.
 */
function toDateOnly(value, timezone) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const ms = toMs(value);
  if (ms == null) return null;
  const parts = utcMsToWallClockParts(ms, timezone);
  return parts.dateOnly;
}

/**
 * Convert a YYYY-MM-DD anchor (or Date) to a UTC ms instant of
 * midnight in the timezone, used for week-overlap testing.
 */
function dateOnlyToTzMidnightMs(value, timezone) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return wallClockToUtcMs({ year: y, month: m, day: d }, timezone);
  }
  return toMs(value);
}

/**
 * Read pay-period-relevant org settings, with TC-aligned defaults.
 * The cron always passes a fully-populated settings object; the
 * defaults exist so tests stay short.
 */
function readPayrollSettings(orgSettings) {
  const settings = orgSettings || {};
  const payroll = settings.payroll || {};
  return {
    timezone: typeof payroll.timezone === 'string' && payroll.timezone.length > 0
      ? payroll.timezone
      : 'America/Los_Angeles',
    jurisdiction: typeof payroll.ot_jurisdiction === 'string' && payroll.ot_jurisdiction.length > 0
      ? payroll.ot_jurisdiction
      : 'CA',
    mileageRate: Number.isFinite(payroll.mileage_rate) ? Number(payroll.mileage_rate) : 0.725,
  };
}

/**
 * Resolve a shift's effective worked window from its clock_events
 * (preferred) or scheduled times (fallback).
 *
 * Returns:
 *   {
 *     shift,
 *     startMs, endMs,           // null if not resolvable
 *     usedClockEvents: boolean, // true when at least clock-in came from clock_events
 *     missingClockOut: boolean, // true when there's an 'in' but no 'out'
 *     missingClockIn: boolean,  // true when no 'in' event at all
 *   }
 */
function resolveShiftWindow(shift, eventsForShift) {
  const ins = eventsForShift.filter((e) => e.event_type === 'in');
  const outs = eventsForShift.filter((e) => e.event_type === 'out');

  // First clock-in (chronologically) is the start; last clock-out is the end.
  const sortByOccurredAt = (a, b) => toMs(a.occurred_at) - toMs(b.occurred_at);
  ins.sort(sortByOccurredAt);
  outs.sort(sortByOccurredAt);

  const firstIn = ins[0]?.occurred_at ?? null;
  const lastOut = outs.length > 0 ? outs[outs.length - 1].occurred_at : null;

  const scheduledStart = shift.start_time ?? null;
  const scheduledEnd = shift.end_time ?? null;

  let startMs;
  let endMs;
  let missingClockIn = false;
  let missingClockOut = false;
  let usedClockEvents = false;

  if (firstIn && lastOut) {
    startMs = toMs(firstIn);
    endMs = toMs(lastOut);
    usedClockEvents = true;
  } else if (firstIn && !lastOut) {
    startMs = toMs(firstIn);
    endMs = toMs(scheduledEnd);
    missingClockOut = true;
    usedClockEvents = true;
  } else if (!firstIn && lastOut) {
    startMs = toMs(scheduledStart);
    endMs = toMs(lastOut);
    missingClockIn = true;
  } else {
    startMs = toMs(scheduledStart);
    endMs = toMs(scheduledEnd);
    // Only flag missing clock-out for shifts that were scheduled as
    // worked. Cancelled / open / no_show shifts don't expect a clock
    // event in the first place — those statuses are filtered out
    // before the builder runs.
    missingClockOut = true;
    missingClockIn = true;
  }

  return {
    shift,
    startMs,
    endMs,
    usedClockEvents,
    missingClockIn,
    missingClockOut,
  };
}

/**
 * Pick the dominant hour classification for a single shift's
 * (regular, overtime, doubleTime) split. Ties broken
 * regular > overtime > double_time so a clean 8h shift always
 * records as `regular`.
 */
function dominantClassification(reg, ot, dt) {
  if (reg >= ot && reg >= dt) return HOUR_CLASSIFICATION.REGULAR;
  if (ot >= dt) return HOUR_CLASSIFICATION.OVERTIME;
  return HOUR_CLASSIFICATION.DOUBLE_TIME;
}

/**
 * Most common non-null `hourly_rate` among the week's shifts. When
 * multiple rates tie, the lowest one wins (so a typo accidentally
 * inflating one shift's rate doesn't accidentally inflate the whole
 * timesheet's gross_pay computation; the rate_mismatch exception
 * surfaces it for back-office review).
 */
function pickPrimaryRate(shifts) {
  const counts = new Map();
  for (const s of shifts) {
    const r = s.hourly_rate;
    if (typeof r !== 'number' || !Number.isFinite(r)) continue;
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  if (counts.size === 0) return null;
  let best = { rate: null, count: -1 };
  for (const [rate, count] of counts) {
    if (count > best.count || (count === best.count && rate < best.rate)) {
      best = { rate, count };
    }
  }
  return best.rate;
}

/**
 * Build a draft timesheet (and its line items) for one caregiver/week.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.caregiverId
 * @param {string|Date} args.weekStart  Monday in tz. YYYY-MM-DD or Date.
 * @param {string|Date} args.weekEnd    Sunday in tz. YYYY-MM-DD or Date.
 * @param {Array<object>} args.shifts
 *   Caregiver's shift rows that overlap the workweek. The caller
 *   (the cron) is responsible for fetching with WHERE
 *   `start_time < weekEnd+1d AND end_time > weekStart` and filtering
 *   to non-cancelled statuses.
 * @param {Array<object>} args.clockEvents
 *   Clock events for those shifts. The builder filters by shift_id
 *   internally; passing extras is harmless.
 * @param {object} args.orgSettings
 *   `organizations.settings` jsonb. Reads timezone, jurisdiction,
 *   mileage_rate from `payroll`.
 *
 * @returns {null | {
 *   timesheet: object,             // shape suitable for INSERT into timesheets
 *   timesheet_shifts: Array<object>, // shape suitable for INSERT into timesheet_shifts
 *   meta: object,                  // builder-only metadata for exception detection
 * }}
 */
export function buildTimesheet({
  orgId,
  caregiverId,
  weekStart,
  weekEnd,
  shifts,
  clockEvents,
  orgSettings,
}) {
  if (!orgId) throw new Error('timesheetBuilder: orgId is required');
  if (!caregiverId) throw new Error('timesheetBuilder: caregiverId is required');
  if (!weekStart) throw new Error('timesheetBuilder: weekStart is required');
  if (!weekEnd) throw new Error('timesheetBuilder: weekEnd is required');
  if (!Array.isArray(shifts)) throw new Error('timesheetBuilder: shifts must be an array');
  if (!Array.isArray(clockEvents)) {
    throw new Error('timesheetBuilder: clockEvents must be an array');
  }

  const { timezone, jurisdiction, mileageRate } = readPayrollSettings(orgSettings);

  const weekStartMs = dateOnlyToTzMidnightMs(weekStart, timezone);
  // weekEnd is the last calendar day of the workweek (Sunday). The
  // exclusive right edge is the start of the following Monday.
  const weekEndStr = toDateOnly(weekEnd, timezone);
  const [wy, wm, wd] = weekEndStr.split('-').map(Number);
  const weekEndExclusiveMs = wallClockToUtcMs(
    { year: wy, month: wm, day: wd + 1 },
    timezone,
  );

  // Filter shifts to those that overlap the workweek and belong to
  // this caregiver. Defensive — the cron should have filtered
  // upstream, but a wrong-caregiver row leaking through here would
  // pollute the wrong timesheet.
  const inWeekShifts = shifts.filter((s) => {
    if (s.assigned_caregiver_id !== caregiverId) return false;
    const sMs = toMs(s.start_time);
    const eMs = toMs(s.end_time);
    if (sMs == null && eMs == null) return false;
    const startMs = sMs ?? eMs;
    const endMs = eMs ?? sMs;
    return startMs < weekEndExclusiveMs && endMs > weekStartMs;
  });

  if (inWeekShifts.length === 0) return null;

  // Resolve actual worked window for each shift.
  const eventsByShiftId = new Map();
  for (const e of clockEvents) {
    if (!e.shift_id) continue;
    if (!eventsByShiftId.has(e.shift_id)) eventsByShiftId.set(e.shift_id, []);
    eventsByShiftId.get(e.shift_id).push(e);
  }

  const resolved = inWeekShifts.map((s) =>
    resolveShiftWindow(s, eventsByShiftId.get(s.id) || []),
  );

  // Run the OT engine on resolvable, non-zero shifts only.
  const otShifts = [];
  for (const r of resolved) {
    if (r.startMs == null || r.endMs == null) continue;
    if (r.endMs <= r.startMs) continue;
    otShifts.push({
      id: r.shift.id,
      startTime: new Date(r.startMs).toISOString(),
      endTime: new Date(r.endMs).toISOString(),
    });
  }

  const otResult = classifyHours({
    shifts: otShifts,
    weekStart: toDateOnly(weekStart, timezone),
    jurisdiction,
    timezone,
  });

  // Build per-shift timesheet_shifts rows.
  const byShiftMap = new Map(otResult.byShift.map((row) => [row.shiftId, row]));
  const timesheetShiftRows = resolved.map((r) => {
    const cls = byShiftMap.get(r.shift.id);
    const reg = cls ? cls.regular : 0;
    const ot = cls ? cls.overtime : 0;
    const dt = cls ? cls.doubleTime : 0;
    const totalHours = cls ? cls.totalHours : 0;
    const mileage = Number.isFinite(r.shift.mileage) ? Number(r.shift.mileage) : 0;
    return {
      shift_id: r.shift.id,
      hours_worked: round2(totalHours),
      hour_classification: dominantClassification(reg, ot, dt),
      mileage: round2(mileage),
    };
  });

  // Skip the timesheet entirely when neither hours nor mileage exist.
  const totalShiftHours = timesheetShiftRows.reduce((s, x) => s + x.hours_worked, 0);
  const totalMileage = timesheetShiftRows.reduce((s, x) => s + x.mileage, 0);
  if (totalShiftHours === 0 && totalMileage === 0) return null;

  // Gross pay using per-shift rates + CA weighted-average regular rate
  // of pay. Each shift contributes:
  //   - Σ (regular_seg × shift_rate)  for its regular hours
  //   - Σ (overtime_seg × shift_rate × 1.5) for its OT hours, computed
  //     against the CA weighted ROP rather than the shift's own rate
  //     when rates vary across the week (DLSE rule). When every shift
  //     carries the same rate the math reduces to base × 1.5.
  //   - Σ (double_time_seg × shift_rate × 2) for its DT hours, same
  //     ROP-blended rule.
  //
  // Implementation note: rather than per-segment rate × multiplier, we
  // pay OT/DT at ROP × multiplier because the SPI export rolls every
  // OT hour into one Paychex row at ROP × 1.5 (Paychex doesn't model
  // the DLSE base+premium decomposition). The two encodings produce
  // the same total cash; the latter matches what the CSV will tell
  // Paychex to actually pay out.
  const ropResult = computeRegularRateOfPay({
    byShiftWithRates: resolved
      .map((r) => {
        const cls = byShiftMap.get(r.shift.id);
        const hours = cls ? cls.totalHours : 0;
        const rate =
          typeof r.shift.hourly_rate === 'number'
            && Number.isFinite(r.shift.hourly_rate)
            ? r.shift.hourly_rate
            : null;
        return { hours, rate };
      })
      .filter((s) => s.hours > 0 && s.rate != null),
  });
  const regularRateOfPay = ropResult.regularRateOfPay;
  const distinctRates = ropResult.distinctRates;
  const primaryRate = pickPrimaryRate(inWeekShifts);

  const perShiftWithRate = resolved.map((r) => {
    const cls = byShiftMap.get(r.shift.id);
    const reg = cls ? cls.regular : 0;
    const ot = cls ? cls.overtime : 0;
    const dt = cls ? cls.doubleTime : 0;
    const rate =
      typeof r.shift.hourly_rate === 'number'
        && Number.isFinite(r.shift.hourly_rate)
        ? r.shift.hourly_rate
        : null;
    return { shiftId: r.shift.id, regular: reg, overtime: ot, doubleTime: dt, rate };
  });

  // Sum the regular component at each shift's own rate. Shifts with
  // no rate contribute 0; the missing-rate condition surfaces in the
  // caller's exception detector via `meta.shiftsMissingRates` below.
  let regularGross = 0;
  for (const ps of perShiftWithRate) {
    if (ps.rate == null) continue;
    regularGross += ps.regular * ps.rate;
  }

  // OT/DT premiums use the weighted ROP. When ROP is null (no shift
  // had a usable rate), gross = 0 and the caller gets to surface that
  // via `caregiver_missing_rate` style exceptions.
  let otGross = 0;
  let dtGross = 0;
  if (regularRateOfPay != null) {
    otGross = otResult.overtime * regularRateOfPay * 1.5;
    dtGross = otResult.doubleTime * regularRateOfPay * 2;
  }

  const grossPay = regularRateOfPay == null
    ? 0
    : round2(regularGross + otGross + dtGross);

  const mileageReimbursement = round2(totalMileage * mileageRate);

  const timesheet = {
    org_id: orgId,
    caregiver_id: caregiverId,
    pay_period_start: toDateOnly(weekStart, timezone),
    pay_period_end: toDateOnly(weekEnd, timezone),
    status: 'draft',
    regular_hours: otResult.regular,
    overtime_hours: otResult.overtime,
    double_time_hours: otResult.doubleTime,
    mileage_total: round2(totalMileage),
    mileage_reimbursement: mileageReimbursement,
    gross_pay: grossPay,
  };

  // Aggregate regular hours per distinct shift rate so the SPI exporter
  // can emit one Hourly row per (worker, rate). Shifts with no rate are
  // silently dropped; their hours still count toward classification but
  // produce no Hourly row (the caller sets a rate before export).
  const regularHoursByRate = new Map();
  for (const ps of perShiftWithRate) {
    if (ps.rate == null) continue;
    if (ps.regular <= 0) continue;
    const prev = regularHoursByRate.get(ps.rate) ?? 0;
    regularHoursByRate.set(ps.rate, prev + ps.regular);
  }
  const regularByRate = Array.from(regularHoursByRate.entries())
    .map(([rate, hours]) => ({ rate, hours: round2(hours) }))
    .sort((a, b) => a.rate - b.rate);

  const meta = {
    primaryRate,
    regularRateOfPay,
    regularByRate,
    distinctRates,
    mileageRate,
    timezone,
    jurisdiction,
    perShift: resolved.map((r) => {
      const cls = byShiftMap.get(r.shift.id);
      return {
        shift_id: r.shift.id,
        startMs: r.startMs,
        endMs: r.endMs,
        usedClockEvents: r.usedClockEvents,
        missingClockIn: r.missingClockIn,
        missingClockOut: r.missingClockOut,
        scheduledStart: r.shift.start_time ?? null,
        scheduledEnd: r.shift.end_time ?? null,
        status: r.shift.status ?? null,
        hourly_rate:
          typeof r.shift.hourly_rate === 'number' && Number.isFinite(r.shift.hourly_rate)
            ? r.shift.hourly_rate
            : null,
        mileage: Number.isFinite(r.shift.mileage) ? Number(r.shift.mileage) : 0,
        regular: cls ? cls.regular : 0,
        overtime: cls ? cls.overtime : 0,
        doubleTime: cls ? cls.doubleTime : 0,
        totalHours: cls ? cls.totalHours : 0,
        // Flags propagated from the clock event lookup; the geofence
        // flag comes from the original clock_events on the shift.
        hadGeofenceFailure: (eventsByShiftId.get(r.shift.id) || []).some(
          (e) => e.geofence_passed === false,
        ),
      };
    }),
  };

  return { timesheet, timesheet_shifts: timesheetShiftRows, meta };
}
