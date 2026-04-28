import { describe, it, expect } from 'vitest';
import { buildTimesheet } from '../timesheetBuilder.js';

const ORG_ID = 'org-tc-uuid';
const CAREGIVER_ID = 'cg_test_001';
const WEEK_START = '2026-04-27';
const WEEK_END = '2026-05-03';

const TZ_SETTINGS = {
  payroll: {
    timezone: 'America/Los_Angeles',
    ot_jurisdiction: 'CA',
    mileage_rate: 0.725,
  },
};

// Helpers — PT wall-clock to UTC ISO. Late-April week is PDT (UTC-7).
function pt(dateIso, hour, minute = 0) {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour + 7, minute)).toISOString();
}

function shift({
  id,
  caregiverId = CAREGIVER_ID,
  date = WEEK_START,
  startHour = 9,
  endHour = 17,
  hourlyRate = 25,
  mileage = 0,
  status = 'completed',
  startTime,
  endTime,
}) {
  return {
    id,
    assigned_caregiver_id: caregiverId,
    start_time: startTime ?? pt(date, startHour),
    end_time: endTime ?? pt(date, endHour),
    hourly_rate: hourlyRate,
    mileage,
    status,
  };
}

function clockIn(shiftId, isoTime, geofence = true) {
  return {
    shift_id: shiftId,
    event_type: 'in',
    occurred_at: isoTime,
    geofence_passed: geofence,
  };
}

function clockOut(shiftId, isoTime, geofence = true) {
  return {
    shift_id: shiftId,
    event_type: 'out',
    occurred_at: isoTime,
    geofence_passed: geofence,
  };
}

// ─── Argument validation ──────────────────────────────────────────

describe('buildTimesheet — argument validation', () => {
  it('throws when orgId is missing', () => {
    expect(() =>
      buildTimesheet({
        caregiverId: CAREGIVER_ID,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        shifts: [],
        clockEvents: [],
        orgSettings: TZ_SETTINGS,
      }),
    ).toThrow(/orgId is required/);
  });

  it('throws when caregiverId is missing', () => {
    expect(() =>
      buildTimesheet({
        orgId: ORG_ID,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        shifts: [],
        clockEvents: [],
        orgSettings: TZ_SETTINGS,
      }),
    ).toThrow(/caregiverId is required/);
  });

  it('throws when shifts is not an array', () => {
    expect(() =>
      buildTimesheet({
        orgId: ORG_ID,
        caregiverId: CAREGIVER_ID,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        shifts: null,
        clockEvents: [],
        orgSettings: TZ_SETTINGS,
      }),
    ).toThrow(/shifts must be an array/);
  });

  it('throws when clockEvents is not an array', () => {
    expect(() =>
      buildTimesheet({
        orgId: ORG_ID,
        caregiverId: CAREGIVER_ID,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        shifts: [],
        clockEvents: null,
        orgSettings: TZ_SETTINGS,
      }),
    ).toThrow(/clockEvents must be an array/);
  });
});

// ─── Empty / null cases ───────────────────────────────────────────

describe('buildTimesheet — empty cases', () => {
  it('returns null when caregiver has no shifts in the week', () => {
    expect(
      buildTimesheet({
        orgId: ORG_ID,
        caregiverId: CAREGIVER_ID,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        shifts: [],
        clockEvents: [],
        orgSettings: TZ_SETTINGS,
      }),
    ).toBeNull();
  });

  it('returns null when all shifts are for a different caregiver', () => {
    expect(
      buildTimesheet({
        orgId: ORG_ID,
        caregiverId: CAREGIVER_ID,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        shifts: [shift({ id: 's1', caregiverId: 'other_caregiver' })],
        clockEvents: [],
        orgSettings: TZ_SETTINGS,
      }),
    ).toBeNull();
  });

  it('returns null when shifts fall entirely outside the workweek', () => {
    expect(
      buildTimesheet({
        orgId: ORG_ID,
        caregiverId: CAREGIVER_ID,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
        shifts: [
          // Sunday Apr 26 (prior week)
          shift({ id: 's_prior', date: '2026-04-26' }),
        ],
        clockEvents: [],
        orgSettings: TZ_SETTINGS,
      }),
    ).toBeNull();
  });

  it('returns null when shifts have zero hours and zero mileage', () => {
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [shift({ id: 's_empty', startHour: 9, endHour: 9, mileage: 0 })],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result).toBeNull();
  });
});

// ─── Clean week ───────────────────────────────────────────────────

describe('buildTimesheet — clean week', () => {
  it('produces a draft timesheet with reg/ot/dt totals matching the OT engine', () => {
    const shifts = [
      shift({ id: 's_mon', date: '2026-04-27', startHour: 9, endHour: 17 }),
      shift({ id: 's_tue', date: '2026-04-28', startHour: 9, endHour: 17 }),
      shift({ id: 's_wed', date: '2026-04-29', startHour: 9, endHour: 17 }),
      shift({ id: 's_thu', date: '2026-04-30', startHour: 9, endHour: 17 }),
      shift({ id: 's_fri', date: '2026-05-01', startHour: 9, endHour: 17 }),
    ];
    const clockEvents = shifts.flatMap((s) => [
      clockIn(s.id, s.start_time),
      clockOut(s.id, s.end_time),
    ]);

    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts,
      clockEvents,
      orgSettings: TZ_SETTINGS,
    });

    expect(result).not.toBeNull();
    expect(result.timesheet).toMatchObject({
      org_id: ORG_ID,
      caregiver_id: CAREGIVER_ID,
      pay_period_start: WEEK_START,
      pay_period_end: WEEK_END,
      status: 'draft',
      regular_hours: 40,
      overtime_hours: 0,
      double_time_hours: 0,
      mileage_total: 0,
      mileage_reimbursement: 0,
      gross_pay: 1000, // 40 * 25
    });
    expect(result.timesheet_shifts).toHaveLength(5);
    expect(result.timesheet_shifts.every((r) => r.hour_classification === 'regular')).toBe(true);
    expect(result.timesheet_shifts.every((r) => r.hours_worked === 8)).toBe(true);
  });

  it('uses clock_events when present and ignores scheduled times', () => {
    const s = shift({ id: 's1', startHour: 9, endHour: 17 });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      // Caregiver clocked in at 9:30, out at 16:45 — actual worked = 7.25h
      clockEvents: [
        clockIn('s1', pt('2026-04-27', 9, 30)),
        clockOut('s1', pt('2026-04-27', 16, 45)),
      ],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet.regular_hours).toBe(7.25);
    expect(result.timesheet_shifts[0].hours_worked).toBe(7.25);
  });

  it('falls back to scheduled times when no clock_events', () => {
    const s = shift({ id: 's1', startHour: 9, endHour: 17 });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet.regular_hours).toBe(8);
  });

  it('records dominant classification on each timesheet_shifts row', () => {
    // 12h shift: 8 reg + 4 OT → dominant = regular.
    const s = shift({ id: 's12', startHour: 6, endHour: 18 });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet_shifts[0].hour_classification).toBe('regular');
    expect(result.timesheet_shifts[0].hours_worked).toBe(12);
  });
});

// ─── Missing clock-out ────────────────────────────────────────────

describe('buildTimesheet — missing clock-out', () => {
  it('falls back to scheduled end and flags missingClockOut in meta', () => {
    const s = shift({ id: 's1', startHour: 9, endHour: 17 });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [clockIn('s1', pt('2026-04-27', 9))],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet.regular_hours).toBe(8); // scheduled fallback
    const perShift = result.meta.perShift.find((p) => p.shift_id === 's1');
    expect(perShift.missingClockOut).toBe(true);
    expect(perShift.usedClockEvents).toBe(true);
  });

  it('flags missingClockIn when only the clock-out exists', () => {
    const s = shift({ id: 's1', startHour: 9, endHour: 17 });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [clockOut('s1', pt('2026-04-27', 17))],
      orgSettings: TZ_SETTINGS,
    });
    const perShift = result.meta.perShift.find((p) => p.shift_id === 's1');
    expect(perShift.missingClockIn).toBe(true);
  });

  it('flags both missing when shift has no clock_events', () => {
    const s = shift({ id: 's1' });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    const perShift = result.meta.perShift[0];
    expect(perShift.missingClockIn).toBe(true);
    expect(perShift.missingClockOut).toBe(true);
    expect(perShift.usedClockEvents).toBe(false);
  });
});

// ─── Mileage handling ─────────────────────────────────────────────

describe('buildTimesheet — mileage', () => {
  it('multiplies mileage_total by org mileage_rate for reimbursement', () => {
    const s = shift({ id: 's1', mileage: 50, startHour: 9, endHour: 17 });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet.mileage_total).toBe(50);
    expect(result.timesheet.mileage_reimbursement).toBe(36.25); // 50 * 0.725
  });

  it('produces a timesheet for mileage-only shifts (zero hours, mileage > 0)', () => {
    // The shift is "completed" but the caregiver worked 0 hours and only
    // logged mileage. Realistic for "drove to client, was sent away, billed mileage."
    const s = shift({ id: 's_mile', startHour: 9, endHour: 9, mileage: 12 });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result).not.toBeNull();
    expect(result.timesheet.regular_hours).toBe(0);
    expect(result.timesheet.mileage_total).toBe(12);
    expect(result.timesheet.mileage_reimbursement).toBe(8.7); // 12 * 0.725
    expect(result.timesheet_shifts).toHaveLength(1);
    expect(result.timesheet_shifts[0].hours_worked).toBe(0);
    expect(result.timesheet_shifts[0].mileage).toBe(12);
  });

  it('sums mileage across all shifts in the week', () => {
    const shifts = [
      shift({ id: 's1', date: '2026-04-27', mileage: 10 }),
      shift({ id: 's2', date: '2026-04-28', mileage: 15.5 }),
      shift({ id: 's3', date: '2026-04-29', mileage: 0 }),
    ];
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts,
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet.mileage_total).toBe(25.5);
    expect(result.timesheet.mileage_reimbursement).toBe(round2(25.5 * 0.725));
  });

  it('treats null mileage as 0', () => {
    const s = { ...shift({ id: 's1' }), mileage: null };
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet.mileage_total).toBe(0);
  });
});

// ─── Rate handling ────────────────────────────────────────────────

describe('buildTimesheet — gross_pay & rate handling', () => {
  it('computes gross_pay using OT multipliers (1.5x and 2x)', () => {
    // 13h shift: 8 reg + 4 ot + 1 dt @ $20/hr.
    // gross = 8*20 + 4*20*1.5 + 1*20*2 = 160 + 120 + 40 = 320.
    const s = shift({ id: 's1', startHour: 6, endHour: 19, hourlyRate: 20 });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet.gross_pay).toBe(320);
  });

  it('pays each shift at its own rate when shifts carry distinct rates (Phase 4 PR #2)', () => {
    const shifts = [
      shift({ id: 's1', date: '2026-04-27', hourlyRate: 25 }), // 8h @ 25
      shift({ id: 's2', date: '2026-04-28', hourlyRate: 25 }), // 8h @ 25
      shift({ id: 's3', date: '2026-04-29', hourlyRate: 30 }), // 8h @ 30
    ];
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts,
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.meta.distinctRates.sort()).toEqual([25, 30]);
    // 16h reg @ $25 + 8h reg @ $30 = $400 + $240 = $640
    // No OT/DT in this 24h workweek so the weighted ROP isn't used.
    expect(result.timesheet.gross_pay).toBe(640);
    // ROP = (16*25 + 8*30) / 24 = 640 / 24 ≈ 26.6667
    expect(result.meta.regularRateOfPay).toBeCloseTo(26.6667, 4);
  });

  it('exposes regular_by_rate aggregated per distinct shift rate', () => {
    const shifts = [
      shift({ id: 's1', date: '2026-04-27', hourlyRate: 25, startHour: 9, endHour: 17 }),
      shift({ id: 's2', date: '2026-04-28', hourlyRate: 25, startHour: 9, endHour: 17 }),
      shift({ id: 's3', date: '2026-04-29', hourlyRate: 30, startHour: 9, endHour: 17 }),
    ];
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts,
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    // Two buckets: 16h @ $25 and 8h @ $30
    const buckets = result.meta.regularByRate;
    expect(buckets).toHaveLength(2);
    expect(buckets.find((b) => b.rate === 25).hours).toBe(16);
    expect(buckets.find((b) => b.rate === 30).hours).toBe(8);
  });

  it('returns gross_pay = 0 when no shift has a usable rate', () => {
    const s = { ...shift({ id: 's1' }), hourly_rate: null };
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet.gross_pay).toBe(0);
    expect(result.meta.primaryRate).toBe(null);
  });
});

// ─── Long shifts ──────────────────────────────────────────────────

describe('buildTimesheet — long shifts', () => {
  it('records a single 18h shift with totalHours 18 (warning-eligible)', () => {
    const s = shift({ id: 's_long', startHour: 5, endHour: 23, hourlyRate: 20 });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet_shifts[0].hours_worked).toBe(18);
    expect(result.timesheet.regular_hours).toBe(8);
    expect(result.timesheet.overtime_hours).toBe(4);
    expect(result.timesheet.double_time_hours).toBe(6);
    // gross = 8*20 + 4*30 + 6*40 = 160 + 120 + 240 = 520
    expect(result.timesheet.gross_pay).toBe(520);
  });
});

// ─── DST ──────────────────────────────────────────────────────────

describe('buildTimesheet — DST week', () => {
  it('handles spring-forward week correctly (Mar 2 → Mar 8 2026)', () => {
    // A clean Mon-Fri 8h schedule the week of spring-forward.
    // Spring forward happens Sunday at the end of the week, so M-F is
    // unaffected. Total should still be 40 reg.
    const dates = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'];
    const shifts = dates.map((d, i) => {
      const [y, mm, dd] = d.split('-').map(Number);
      return {
        id: `s${i}`,
        assigned_caregiver_id: CAREGIVER_ID,
        start_time: new Date(Date.UTC(y, mm - 1, dd, 17, 0)).toISOString(), // 9am PST
        end_time: new Date(Date.UTC(y, mm - 1, dd, 25, 0)).toISOString(),   // 5pm PST
        hourly_rate: 25,
        mileage: 0,
        status: 'completed',
      };
    });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: '2026-03-02',
      weekEnd: '2026-03-08',
      shifts,
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet.regular_hours).toBe(40);
  });

  it('handles a shift that spans the spring-forward gap', () => {
    // Sat 11pm PST (Mar 7) → Sun 4am PDT (Mar 8) = 4 actual hours.
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: '2026-03-02',
      weekEnd: '2026-03-08',
      shifts: [
        {
          id: 'springfwd',
          assigned_caregiver_id: CAREGIVER_ID,
          start_time: '2026-03-08T07:00:00Z',
          end_time: '2026-03-08T11:00:00Z',
          hourly_rate: 25,
          mileage: 0,
          status: 'completed',
        },
      ],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.timesheet_shifts[0].hours_worked).toBe(4);
    expect(result.timesheet.regular_hours).toBe(4);
    expect(result.timesheet.gross_pay).toBe(100); // 4 * 25
  });
});

// ─── Geofence pass-through ────────────────────────────────────────

describe('buildTimesheet — geofence flag pass-through', () => {
  it('reports geofence failures via meta.perShift', () => {
    const s = shift({ id: 's1' });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [
        clockIn('s1', s.start_time, false), // failed geofence
        clockOut('s1', s.end_time, true),
      ],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.meta.perShift[0].hadGeofenceFailure).toBe(true);
  });

  it('reports false when geofence_passed is true on every event', () => {
    const s = shift({ id: 's1' });
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [s],
      clockEvents: [clockIn('s1', s.start_time), clockOut('s1', s.end_time)],
      orgSettings: TZ_SETTINGS,
    });
    expect(result.meta.perShift[0].hadGeofenceFailure).toBe(false);
  });
});

// ─── Cross-week shifts ────────────────────────────────────────────

describe('buildTimesheet — week boundary shifts', () => {
  it('counts only the in-week portion of a shift that overlaps the workweek', () => {
    // Shift starts Sun Apr 26 11pm PT (PRIOR week), ends Mon Apr 27 5am PT (THIS week).
    const result = buildTimesheet({
      orgId: ORG_ID,
      caregiverId: CAREGIVER_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      shifts: [
        {
          id: 's_overlap',
          assigned_caregiver_id: CAREGIVER_ID,
          start_time: pt('2026-04-26', 23),
          end_time: pt('2026-04-27', 5),
          hourly_rate: 25,
          mileage: 0,
          status: 'completed',
        },
      ],
      clockEvents: [],
      orgSettings: TZ_SETTINGS,
    });
    // Mon portion = 5 hours.
    expect(result.timesheet.regular_hours).toBe(5);
    // The shift_id appears in this week's timesheet_shifts, but the
    // `hours_worked` reflects only what classifyHours attributed.
    expect(result.timesheet_shifts[0].hours_worked).toBe(5);
  });
});

// helper used in the rate-test
function round2(n) {
  return Math.round(n * 100) / 100;
}
