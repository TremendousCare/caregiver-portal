import { describe, it, expect } from 'vitest';
import { classifyHours, computeRegularRateOfPay } from '../overtimeRules.js';

// ─── Test fixtures ─────────────────────────────────────────────────
//
// All shifts are constructed in PT and then converted to UTC ISO so
// the engine sees real timestamps. Pacific is UTC-8 (PST) most of the
// year, UTC-7 (PDT) during Daylight Saving Time. The fixtures below
// pick weeks that are well outside DST transitions; the DST-specific
// tests cite their dates explicitly.
//
// Workweek starts Monday in PT. For week starting 2026-04-27 (a
// Monday in late April → PDT → UTC-7):
//   Monday 2026-04-27 00:00 PT = 2026-04-27T07:00:00Z
//   Sunday 2026-05-03 23:59 PT = 2026-05-04T06:59:00Z
//
// Shifts are produced in UTC by adding hours of PDT offset.

const TZ = 'America/Los_Angeles';
const WEEK_START = '2026-04-27'; // Monday, PDT

/**
 * Build a UTC ISO timestamp from PT wall-clock components (PDT, since
 * the test weeks are in late April / late June). For DST-spanning
 * tests we pass UTC instants directly.
 */
function pt(dateIso, hour, minute = 0) {
  // PDT = UTC-7
  // dateIso is the PT calendar date.
  const [y, m, d] = dateIso.split('-').map(Number);
  // wall-clock hour in PT → add 7 to get UTC hour
  const utcHour = hour + 7;
  const dt = new Date(Date.UTC(y, m - 1, d, utcHour, minute));
  return dt.toISOString();
}

function pst(dateIso, hour, minute = 0) {
  // PST = UTC-8 — used for tests in Jan/Feb/Nov/Dec
  const [y, m, d] = dateIso.split('-').map(Number);
  const utcHour = hour + 8;
  const dt = new Date(Date.UTC(y, m - 1, d, utcHour, minute));
  return dt.toISOString();
}

function shift(id, startIso, endIso) {
  return { id, startTime: startIso, endTime: endIso };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('classifyHours — argument validation', () => {
  it('throws when jurisdiction is not CA', () => {
    expect(() =>
      classifyHours({
        shifts: [],
        weekStart: WEEK_START,
        jurisdiction: 'NY',
        timezone: TZ,
      }),
    ).toThrow(/jurisdiction "NY"/);
  });

  it('throws when jurisdiction is empty', () => {
    expect(() =>
      classifyHours({
        shifts: [],
        weekStart: WEEK_START,
        jurisdiction: '',
        timezone: TZ,
      }),
    ).toThrow(/jurisdiction/);
  });

  it('throws when shifts is not an array', () => {
    expect(() =>
      classifyHours({
        shifts: null,
        weekStart: WEEK_START,
        jurisdiction: 'CA',
        timezone: TZ,
      }),
    ).toThrow(/shifts must be an array/);
  });

  it('throws when a shift is missing an id', () => {
    expect(() =>
      classifyHours({
        shifts: [{ startTime: pt('2026-04-27', 8), endTime: pt('2026-04-27', 12) }],
        weekStart: WEEK_START,
        jurisdiction: 'CA',
        timezone: TZ,
      }),
    ).toThrow(/non-empty id/);
  });

  it('throws when a shift has unparseable start time', () => {
    expect(() =>
      classifyHours({
        shifts: [{ id: 's1', startTime: 'banana', endTime: pt('2026-04-27', 12) }],
        weekStart: WEEK_START,
        jurisdiction: 'CA',
        timezone: TZ,
      }),
    ).toThrow(/parseable date/);
  });

  it('throws when weekStart is unparseable', () => {
    expect(() =>
      classifyHours({
        shifts: [],
        weekStart: 'not a date',
        jurisdiction: 'CA',
        timezone: TZ,
      }),
    ).toThrow(/weekStart/);
  });
});

describe('classifyHours — empty / trivial cases', () => {
  it('returns all zeros for an empty workweek', () => {
    const result = classifyHours({
      shifts: [],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.regular).toBe(0);
    expect(result.overtime).toBe(0);
    expect(result.doubleTime).toBe(0);
    expect(result.byShift).toEqual([]);
    expect(result.byDay).toHaveLength(7);
    expect(result.byDay.every((d) => d.totalHours === 0)).toBe(true);
  });

  it('drops shifts with zero duration (mileage-only "shifts")', () => {
    const result = classifyHours({
      shifts: [shift('s_zero', pt('2026-04-27', 8), pt('2026-04-27', 8))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.regular).toBe(0);
    expect(result.byShift).toEqual([]);
  });

  it('drops shifts where end < start (missing clock-out fallback)', () => {
    const result = classifyHours({
      shifts: [shift('s_neg', pt('2026-04-27', 12), pt('2026-04-27', 8))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.regular).toBe(0);
    expect(result.byShift).toEqual([]);
  });

  it('ignores shifts that fall entirely outside the workweek', () => {
    const result = classifyHours({
      // Sunday Apr 26 is the day BEFORE WEEK_START (Apr 27 Mon).
      shifts: [shift('s_prior', pt('2026-04-26', 8), pt('2026-04-26', 16))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.regular).toBe(0);
    expect(result.overtime).toBe(0);
  });
});

describe('classifyHours — daily thresholds', () => {
  it('classifies a 6h shift as 6 regular', () => {
    const result = classifyHours({
      shifts: [shift('s', pt('2026-04-27', 8), pt('2026-04-27', 14))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.regular).toBe(6);
    expect(result.overtime).toBe(0);
    expect(result.doubleTime).toBe(0);
    expect(result.byShift[0]).toEqual({
      shiftId: 's',
      regular: 6,
      overtime: 0,
      doubleTime: 0,
      totalHours: 6,
    });
  });

  it('classifies an 8h shift as 8 regular (boundary)', () => {
    const result = classifyHours({
      shifts: [shift('s', pt('2026-04-27', 8), pt('2026-04-27', 16))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 8, overtime: 0, doubleTime: 0 });
  });

  it('classifies a 9h shift as 8 regular + 1 OT', () => {
    const result = classifyHours({
      shifts: [shift('s', pt('2026-04-27', 8), pt('2026-04-27', 17))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 8, overtime: 1, doubleTime: 0 });
  });

  it('classifies a 12h shift as 8 regular + 4 OT (DT boundary)', () => {
    const result = classifyHours({
      shifts: [shift('s', pt('2026-04-27', 8), pt('2026-04-27', 20))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 8, overtime: 4, doubleTime: 0 });
  });

  it('classifies a 13h shift as 8 regular + 4 OT + 1 DT', () => {
    const result = classifyHours({
      shifts: [shift('s', pt('2026-04-27', 8), pt('2026-04-27', 21))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 8, overtime: 4, doubleTime: 1 });
  });

  it('classifies a 16h shift as 8 reg + 4 OT + 4 DT', () => {
    const result = classifyHours({
      shifts: [shift('s', pt('2026-04-27', 6), pt('2026-04-27', 22))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 8, overtime: 4, doubleTime: 4 });
  });
});

describe('classifyHours — weekly threshold', () => {
  it('40h across 5 weekdays is all regular (boundary)', () => {
    const shifts = [];
    for (let i = 0; i < 5; i += 1) {
      const day = String(27 + i).padStart(2, '0');
      shifts.push(shift(`s${i}`, pt(`2026-04-${day}`, 9), pt(`2026-04-${day}`, 17)));
    }
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 40, overtime: 0, doubleTime: 0 });
  });

  it('41h across 5 weekdays + 1h Saturday → 40 reg + 1 OT', () => {
    const shifts = [];
    for (let i = 0; i < 5; i += 1) {
      const day = String(27 + i).padStart(2, '0');
      shifts.push(shift(`s${i}`, pt(`2026-04-${day}`, 9), pt(`2026-04-${day}`, 17)));
    }
    shifts.push(shift('s_sat', pt('2026-05-02', 9), pt('2026-05-02', 10)));
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 40, overtime: 1, doubleTime: 0 });
    const sat = result.byShift.find((s) => s.shiftId === 's_sat');
    expect(sat).toEqual({ shiftId: 's_sat', regular: 0, overtime: 1, doubleTime: 0, totalHours: 1 });
  });

  it('5×9h = 45h: each day 8 reg + 1 OT (daily OT, no weekly excess)', () => {
    const shifts = [];
    for (let i = 0; i < 5; i += 1) {
      const day = String(27 + i).padStart(2, '0');
      shifts.push(shift(`s${i}`, pt(`2026-04-${day}`, 9), pt(`2026-04-${day}`, 18)));
    }
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 40, overtime: 5, doubleTime: 0 });
  });

  it('6×7h = 42h (no daily OT) → 40 reg + 2 OT (weekly cap fires)', () => {
    const shifts = [];
    const dates = ['2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30', '2026-05-01', '2026-05-02'];
    for (let i = 0; i < dates.length; i += 1) {
      shifts.push(shift(`s${i}`, pt(dates[i], 9), pt(dates[i], 16)));
    }
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 40, overtime: 2, doubleTime: 0 });
    const sat = result.byShift.find((s) => s.shiftId === 's5');
    // Saturday is the 6th workday; it's the chronologically last day
    // and should absorb the 2h excess.
    expect(sat).toMatchObject({ regular: 5, overtime: 2 });
  });

  it('weekly cap moves excess from the chronologically latest reg hours', () => {
    const shifts = [
      shift('mon', pt('2026-04-27', 9), pt('2026-04-27', 17)), // 8h
      shift('tue', pt('2026-04-28', 9), pt('2026-04-28', 17)), // 8h
      shift('wed', pt('2026-04-29', 9), pt('2026-04-29', 17)), // 8h
      shift('thu', pt('2026-04-30', 9), pt('2026-04-30', 17)), // 8h
      shift('fri', pt('2026-05-01', 9), pt('2026-05-01', 17)), // 8h  → 40 reg cumul
      shift('sat', pt('2026-05-02', 9), pt('2026-05-02', 12)), // 3h all OT
    ];
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 40, overtime: 3, doubleTime: 0 });
    const sat = result.byShift.find((s) => s.shiftId === 'sat');
    expect(sat).toEqual({
      shiftId: 'sat',
      regular: 0,
      overtime: 3,
      doubleTime: 0,
      totalHours: 3,
    });
  });
});

describe('classifyHours — 7th consecutive day rule', () => {
  it('all 7 days × 7h = 49h: 40 reg + 9 OT (7th day rule + weekly cap)', () => {
    // Days 0-5: 7 reg each (no daily OT, under 8h).
    // Day 6 (7th): all 7h treated as OT (under 8h on 7th day).
    // Sum reg from days 0-5 = 42 → cap to 40, push 2h reg → OT (last
    // chronological reg = day 5 Saturday).
    // Expected: 40 reg, 9 OT, 0 DT.
    const shifts = [];
    const dates = [
      '2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30',
      '2026-05-01', '2026-05-02', '2026-05-03',
    ];
    for (let i = 0; i < dates.length; i += 1) {
      shifts.push(shift(`d${i}`, pt(dates[i], 9), pt(dates[i], 16)));
    }
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 40, overtime: 9, doubleTime: 0 });
    expect(result.byDay[6].isSeventhConsecutiveDay).toBe(true);
    expect(result.byDay[6]).toMatchObject({ regular: 0, overtime: 7, doubleTime: 0 });
  });

  it('7 days × 8h = 56h: 40 reg + 16 OT', () => {
    const shifts = [];
    const dates = [
      '2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30',
      '2026-05-01', '2026-05-02', '2026-05-03',
    ];
    for (let i = 0; i < dates.length; i += 1) {
      shifts.push(shift(`d${i}`, pt(dates[i], 9), pt(dates[i], 17)));
    }
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 40, overtime: 16, doubleTime: 0 });
  });

  it('7 days × 10h = 70h: 7th-day rule pushes part to DT', () => {
    // Days 0-5: each 8 reg + 2 OT = 48 reg + 12 OT cumul.
    // Day 6 (7th): 8 OT + 2 DT.
    // Weekly cap: 48 reg → 40 reg + 8 OT excess from Saturday.
    // Total: 40 reg + 22 OT + 8 OT (day 6 ot) + 2 DT? Wait re-do:
    //   Days 0-4: 5×(8r+2ot) = 40r+10ot
    //   Day 5 Sat: 8r+2ot → cap moves 8r→ot → 0r + 10ot
    //   Day 6 Sun (7th): 8ot + 2dt
    //   Total: 40r + 28ot + 2dt = 70h. Correct.
    const shifts = [];
    const dates = [
      '2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30',
      '2026-05-01', '2026-05-02', '2026-05-03',
    ];
    for (let i = 0; i < dates.length; i += 1) {
      shifts.push(shift(`d${i}`, pt(dates[i], 8), pt(dates[i], 18)));
    }
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 40, overtime: 28, doubleTime: 2 });
  });

  it('rest day on Wednesday breaks consecutiveness (no 7th-day rule)', () => {
    // Mon, Tue, Thu, Fri, Sat, Sun all 6h each (no Wednesday).
    // No 7-consecutive run. Total = 36h regular.
    const dates = ['2026-04-27', '2026-04-28', '2026-04-30', '2026-05-01', '2026-05-02', '2026-05-03'];
    const shifts = dates.map((d, i) => shift(`s${i}`, pt(d, 9), pt(d, 15)));
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 36, overtime: 0, doubleTime: 0 });
    expect(result.byDay[6].isSeventhConsecutiveDay).toBe(false);
  });

  it('Saturday off, Sunday worked: no 7th-day rule', () => {
    const dates = ['2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30', '2026-05-01', '2026-05-03'];
    const shifts = dates.map((d, i) => shift(`s${i}`, pt(d, 9), pt(d, 17)));
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.byDay[6].isSeventhConsecutiveDay).toBe(false);
    // 5 days × 8h + 1 Sun × 8h = 48h.
    // Days 0-4: 8 reg each = 40 reg cumul.
    // Day 5 Sat: 0h.
    // Day 6 Sun: 8 reg → weekly cap pushes all 8 to OT.
    expect(result).toMatchObject({ regular: 40, overtime: 8, doubleTime: 0 });
  });

  it('only flags 7th-day rule when day 6 itself has hours', () => {
    // Mon-Sat all worked, Sun off. Sun has 0h → not 7th-day even though prior 6 worked.
    const dates = ['2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30', '2026-05-01', '2026-05-02'];
    const shifts = dates.map((d, i) => shift(`s${i}`, pt(d, 9), pt(d, 13)));
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.byDay[6].isSeventhConsecutiveDay).toBe(false);
    expect(result.regular).toBe(24);
  });
});

describe('classifyHours — split shifts and within-day distribution', () => {
  it('two shifts on the same day stay regular when total ≤ 8', () => {
    const shifts = [
      shift('morning', pt('2026-04-27', 8), pt('2026-04-27', 12)), // 4h
      shift('afternoon', pt('2026-04-27', 14), pt('2026-04-27', 18)), // 4h
    ];
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 8, overtime: 0, doubleTime: 0 });
    expect(result.byShift.find((s) => s.shiftId === 'morning')).toMatchObject({
      regular: 4,
      overtime: 0,
    });
    expect(result.byShift.find((s) => s.shiftId === 'afternoon')).toMatchObject({
      regular: 4,
      overtime: 0,
    });
  });

  it('two shifts same day totaling 10h: first gets reg, second gets OT in chronological order', () => {
    const shifts = [
      shift('first', pt('2026-04-27', 8), pt('2026-04-27', 14)), // 6h, 8am-2pm
      shift('second', pt('2026-04-27', 15), pt('2026-04-27', 19)), // 4h, 3pm-7pm
    ];
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 8, overtime: 2 });
    expect(result.byShift.find((s) => s.shiftId === 'first')).toMatchObject({
      regular: 6,
      overtime: 0,
    });
    expect(result.byShift.find((s) => s.shiftId === 'second')).toMatchObject({
      regular: 2,
      overtime: 2,
    });
  });

  it('orders segments chronologically even when caller passes them out of order', () => {
    const shifts = [
      shift('late', pt('2026-04-27', 15), pt('2026-04-27', 19)), // 4h afternoon
      shift('early', pt('2026-04-27', 8), pt('2026-04-27', 14)), // 6h morning
    ];
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    // Morning (earliest) should still get all reg first.
    expect(result.byShift.find((s) => s.shiftId === 'early')).toMatchObject({
      regular: 6,
      overtime: 0,
    });
    expect(result.byShift.find((s) => s.shiftId === 'late')).toMatchObject({
      regular: 2,
      overtime: 2,
    });
  });
});

describe('classifyHours — shifts crossing midnight', () => {
  it('a shift crossing midnight splits between two days (non-DST)', () => {
    // Mon 8pm PT to Tue 4am PT = 8h total.
    // Mon portion: 4h. Tue portion: 4h. Both regular.
    const result = classifyHours({
      shifts: [shift('overnight', pt('2026-04-27', 20), pt('2026-04-28', 4))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 8, overtime: 0, doubleTime: 0 });
    expect(result.byDay[0].totalHours).toBe(4);
    expect(result.byDay[1].totalHours).toBe(4);
    expect(result.byShift[0]).toMatchObject({ totalHours: 8 });
  });

  it('an overnight shift contributing to two different days totals correctly', () => {
    // Sat 10pm PT to Sun 6am PT = 8h. Sat = 2h, Sun = 6h.
    const result = classifyHours({
      shifts: [shift('overnight', pt('2026-05-02', 22), pt('2026-05-03', 6))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.byDay[5].totalHours).toBe(2); // Sat
    expect(result.byDay[6].totalHours).toBe(6); // Sun
    expect(result.regular).toBe(8);
  });

  it('only counts in-week portion when shift starts before workweek begins', () => {
    // Sunday 11pm Apr 26 PT (PRE-week) to Monday 5am Apr 27 PT (in week).
    // Pre-week: 1h (dropped). In-week: 5h. So we expect 5 reg.
    const result = classifyHours({
      shifts: [shift('boundary', pt('2026-04-26', 23), pt('2026-04-27', 5))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.regular).toBe(5);
    expect(result.byDay[0].totalHours).toBe(5);
  });
});

describe('classifyHours — DST transitions', () => {
  it('handles spring-forward correctly (lost hour shrinks shift by 1h)', () => {
    // 2026-03-08 is the spring-forward Sunday in PT (clocks jump 2am→3am).
    // Workweek Mon 2026-03-02 (PST → UTC-8) through Sun 2026-03-08 (mixed).
    //
    // Shift: Sat 11pm PST (Mar 7) → Sun 4am PDT (Mar 8). Wall-clock
    // looks like 5 hours but real elapsed time is 4 hours.
    //   Sat 11pm PST = 2026-03-08T07:00:00Z
    //   Sun 4am PDT  = 2026-03-08T11:00:00Z
    //   Duration UTC = 4 hours.
    const result = classifyHours({
      shifts: [
        {
          id: 'springfwd',
          startTime: '2026-03-08T07:00:00Z',
          endTime: '2026-03-08T11:00:00Z',
        },
      ],
      weekStart: '2026-03-02',
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.byShift[0].totalHours).toBe(4);
    // Sat midnight PST = 2026-03-07T08:00Z. Sat portion = 11pm PST to
    // midnight PST = 1h. Sun portion = midnight PST to 4am PDT = 3h
    // (the 2-3am PT wall hour does not exist).
    expect(result.byDay[5].totalHours).toBe(1);
    expect(result.byDay[6].totalHours).toBe(3);
  });

  it('handles fall-back correctly (gained hour grows shift by 1h)', () => {
    // 2026-11-01 is fall-back Sunday in PT (clocks jump 2am PDT → 1am PST).
    // Workweek Mon 2026-10-26 PDT through Sun 2026-11-01 mixed.
    //
    // Shift: Sat 11pm PDT (Oct 31) → Sun 4am PST (Nov 1). Wall-clock
    // looks like 5 hours but real elapsed time is 6 hours.
    //   Sat 11pm PDT = 2026-11-01T06:00:00Z
    //   Sun 4am PST  = 2026-11-01T12:00:00Z
    //   Duration UTC = 6 hours.
    const result = classifyHours({
      shifts: [
        {
          id: 'fallback',
          startTime: '2026-11-01T06:00:00Z',
          endTime: '2026-11-01T12:00:00Z',
        },
      ],
      weekStart: '2026-10-26',
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.byShift[0].totalHours).toBe(6);
    // Sat portion: 11pm PDT to midnight PT = 1h.
    // Sun portion: midnight PT to 4am PST = 5h (the 1-2am hour repeats).
    expect(result.byDay[5].totalHours).toBe(1);
    expect(result.byDay[6].totalHours).toBe(5);
  });
});

describe('classifyHours — high-volume / edge-case scenarios', () => {
  it('5 days × 14h = 70h: 40 reg + 20 OT + 10 DT (no weekly excess)', () => {
    const dates = ['2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30', '2026-05-01'];
    const shifts = dates.map((d, i) => shift(`s${i}`, pt(d, 6), pt(d, 20)));
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 40, overtime: 20, doubleTime: 10 });
  });

  it('6 days × 14h = 84h: 40 reg + 32 OT + 12 DT', () => {
    const dates = [
      '2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30',
      '2026-05-01', '2026-05-02',
    ];
    const shifts = dates.map((d, i) => shift(`s${i}`, pt(d, 6), pt(d, 20)));
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 40, overtime: 32, doubleTime: 12 });
  });

  it('totals always reconcile with byShift sums', () => {
    const shifts = [
      shift('a', pt('2026-04-27', 7), pt('2026-04-27', 19)), // 12h
      shift('b', pt('2026-04-28', 9), pt('2026-04-28', 18.5)), // 9.5h
      shift('c', pt('2026-04-29', 10), pt('2026-04-29', 18)), // 8h
      shift('d', pt('2026-04-30', 8), pt('2026-04-30', 16)), // 8h
      shift('e', pt('2026-05-01', 8), pt('2026-05-01', 16.25)), // 8.25h
    ];
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    const sumReg = result.byShift.reduce((s, x) => s + x.regular, 0);
    const sumOt = result.byShift.reduce((s, x) => s + x.overtime, 0);
    const sumDt = result.byShift.reduce((s, x) => s + x.doubleTime, 0);
    expect(Math.round(sumReg * 100) / 100).toBe(result.regular);
    expect(Math.round(sumOt * 100) / 100).toBe(result.overtime);
    expect(Math.round(sumDt * 100) / 100).toBe(result.doubleTime);
  });

  it('handles fractional hours (15-minute increments) without rounding drift', () => {
    const result = classifyHours({
      shifts: [shift('s', pt('2026-04-27', 8, 15), pt('2026-04-27', 16, 45))],
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    // 8:15am - 4:45pm = 8.5h
    expect(result.byShift[0].totalHours).toBe(8.5);
    expect(result.regular).toBe(8);
    expect(result.overtime).toBe(0.5);
  });

  it('preserves byShift entries that have only OT or only DT hours', () => {
    // Shift A 8h (all reg). Shift B 6h same day → 4 OT + 2 OT actually,
    // wait: total day 14h. Day classification: 8r + 4ot + 2dt.
    // Distribution by chronological order: A is first 8h → 8 reg.
    // B is next 6h → 4 ot + 2 dt.
    const shifts = [
      shift('A', pt('2026-04-27', 6), pt('2026-04-27', 14)),  // 6am-2pm = 8h
      shift('B', pt('2026-04-27', 14), pt('2026-04-27', 20)), // 2pm-8pm = 6h
    ];
    const result = classifyHours({
      shifts,
      weekStart: WEEK_START,
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result.byShift.find((s) => s.shiftId === 'A')).toEqual({
      shiftId: 'A',
      regular: 8,
      overtime: 0,
      doubleTime: 0,
      totalHours: 8,
    });
    expect(result.byShift.find((s) => s.shiftId === 'B')).toEqual({
      shiftId: 'B',
      regular: 0,
      overtime: 4,
      doubleTime: 2,
      totalHours: 6,
    });
  });
});

describe('classifyHours — week boundary in PST timezone', () => {
  it('correctly anchors a January workweek (PST = UTC-8)', () => {
    // Mon 2026-01-05 PST. Use pst() helper.
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
    const shifts = dates.map((d, i) => shift(`s${i}`, pst(d, 9), pst(d, 17)));
    const result = classifyHours({
      shifts,
      weekStart: '2026-01-05',
      jurisdiction: 'CA',
      timezone: TZ,
    });
    expect(result).toMatchObject({ regular: 40, overtime: 0, doubleTime: 0 });
  });
});

describe('classifyHours — defaults', () => {
  it('uses CA + America/Los_Angeles defaults when omitted', () => {
    // No jurisdiction / timezone passed — defaults should apply.
    const result = classifyHours({
      shifts: [shift('s', pt('2026-04-27', 8), pt('2026-04-27', 17))],
      weekStart: WEEK_START,
    });
    expect(result).toMatchObject({ regular: 8, overtime: 1, doubleTime: 0 });
  });
});

// ─── Weighted-average regular rate of pay (Phase 4 PR #2) ─────────
//
// CA Labor Code §510 + DLSE Manual §49.1.2 + DLSE Opinion Letter
// 2002.12.09-2: when shifts in a single workweek carry different
// rates, the OT premium is calculated against a blended "regular
// rate of pay" (ROP) — total straight-time pay divided by total
// non-OT hours worked. The OT half-time premium per OT hour is then
// 0.5 × ROP; DT premium is 1.0 × ROP. Each test below cites the
// arithmetic so a future maintainer can sanity-check by hand.

describe('computeRegularRateOfPay — argument validation', () => {
  it('throws when byShiftWithRates is not an array', () => {
    expect(() => computeRegularRateOfPay({ byShiftWithRates: null })).toThrow(/array/);
    expect(() => computeRegularRateOfPay({ byShiftWithRates: 'nope' })).toThrow(/array/);
  });
});

describe('computeRegularRateOfPay — single rate (degenerate case)', () => {
  it('returns the shift rate when every shift carries the same rate', () => {
    const result = computeRegularRateOfPay({
      byShiftWithRates: [
        { hours: 8, rate: 25 },
        { hours: 8, rate: 25 },
      ],
    });
    expect(result.regularRateOfPay).toBe(25);
    expect(result.distinctRates).toEqual([25]);
    expect(result.totalHoursWorked).toBe(16);
    expect(result.totalStraightTimePay).toBe(400);
  });

  it('returns the rate of the only shift', () => {
    const result = computeRegularRateOfPay({
      byShiftWithRates: [{ hours: 10, rate: 22 }],
    });
    expect(result.regularRateOfPay).toBe(22);
    expect(result.distinctRates).toEqual([22]);
  });
});

describe('computeRegularRateOfPay — two-rate week', () => {
  it('blends 8h@$20 + 16h@$22 → ROP = (8*20 + 16*22) / 24 = 21.3333', () => {
    // straight-time pay = 160 + 352 = 512.  ROP = 512 / 24 ≈ 21.3333.
    const result = computeRegularRateOfPay({
      byShiftWithRates: [
        { hours: 8, rate: 20 },
        { hours: 16, rate: 22 },
      ],
    });
    expect(result.regularRateOfPay).toBeCloseTo(21.3333, 4);
    expect(result.distinctRates).toEqual([20, 22]);
    expect(result.totalHoursWorked).toBe(24);
    expect(result.totalStraightTimePay).toBe(512);
  });

  it('blends 16h@$25 + 8h@$30 → ROP = (16*25 + 8*30) / 24 = 26.6667', () => {
    // straight-time pay = 400 + 240 = 640.  ROP = 640 / 24 ≈ 26.6667.
    const result = computeRegularRateOfPay({
      byShiftWithRates: [
        { hours: 16, rate: 25 },
        { hours: 8, rate: 30 },
      ],
    });
    expect(result.regularRateOfPay).toBeCloseTo(26.6667, 4);
  });
});

describe('computeRegularRateOfPay — DLSE example (the canonical exam question)', () => {
  it('30h@$10 + 15h@$12 → ROP = (300 + 180) / 45 = 10.6667 (matches DLSE manual)', () => {
    // DLSE Manual §49.1.2 worked example: employee works 30h at $10/hr
    // and 15h at $12/hr in the same workweek. Total straight-time =
    // $300 + $180 = $480. Total worked hours = 45. ROP = $480 / 45 =
    // $10.6667. The 5 hours of weekly OT (45 - 40) gets a 0.5× ROP
    // half-time premium of $5.3333/hr on top of straight time.
    const result = computeRegularRateOfPay({
      byShiftWithRates: [
        { hours: 30, rate: 10 },
        { hours: 15, rate: 12 },
      ],
    });
    expect(result.regularRateOfPay).toBeCloseTo(10.6667, 4);
    expect(result.totalStraightTimePay).toBe(480);
    expect(result.totalHoursWorked).toBe(45);
  });
});

describe('computeRegularRateOfPay — null / unusable rates', () => {
  it('returns null ROP when no shift has a usable rate', () => {
    const result = computeRegularRateOfPay({
      byShiftWithRates: [
        { hours: 8, rate: null },
        { hours: 8, rate: undefined },
      ],
    });
    expect(result.regularRateOfPay).toBeNull();
    expect(result.distinctRates).toEqual([]);
  });

  it('drops shifts with null rate from the calculation but keeps usable ones', () => {
    // Worker did 8h with no logged rate (back-office data gap) plus
    // 16h at $20. The DLSE rule is computed against the hours that
    // ARE on the books at a known rate. The rate-missing shift surfaces
    // separately via the `caregiver_missing_rate` exception so the back
    // office can resolve it before approval.
    const result = computeRegularRateOfPay({
      byShiftWithRates: [
        { hours: 8, rate: null },
        { hours: 16, rate: 20 },
      ],
    });
    expect(result.regularRateOfPay).toBe(20);
    expect(result.totalHoursWorked).toBe(16);
    expect(result.totalStraightTimePay).toBe(320);
  });

  it('drops shifts with non-positive rate', () => {
    const result = computeRegularRateOfPay({
      byShiftWithRates: [
        { hours: 8, rate: 0 },
        { hours: 8, rate: -5 },
        { hours: 8, rate: 25 },
      ],
    });
    expect(result.regularRateOfPay).toBe(25);
    expect(result.totalHoursWorked).toBe(8);
  });

  it('drops shifts with non-positive hours', () => {
    const result = computeRegularRateOfPay({
      byShiftWithRates: [
        { hours: 0, rate: 25 },
        { hours: -1, rate: 25 },
        { hours: 8, rate: 25 },
      ],
    });
    expect(result.regularRateOfPay).toBe(25);
    expect(result.totalHoursWorked).toBe(8);
  });
});

describe('computeRegularRateOfPay — three-rate week (sanity)', () => {
  it('handles 8h@$18 + 8h@$22 + 8h@$30 → ROP = 23.3333', () => {
    // straight-time = 144 + 176 + 240 = 560.  ROP = 560 / 24 = 23.3333.
    const result = computeRegularRateOfPay({
      byShiftWithRates: [
        { hours: 8, rate: 18 },
        { hours: 8, rate: 22 },
        { hours: 8, rate: 30 },
      ],
    });
    expect(result.regularRateOfPay).toBeCloseTo(23.3333, 4);
    expect(result.distinctRates).toEqual([18, 22, 30]);
  });
});

describe('computeRegularRateOfPay — premium math', () => {
  it('half-time premium is 0.5 × ROP per OT hour (DLSE half-time encoding)', () => {
    // The DLSE method uses 0.5 × ROP for the OT premium, layered on
    // top of straight-time pay (each hour at its own rate). This
    // helper exposes ROP; the TC SPI export instead encodes the OT
    // total as OT_hours × ROP × 1.5 (full OT rate including base) so
    // that one Paychex Overtime row covers OT pay completely. Both
    // encodings yield identical totals for single-rate weeks; for
    // multi-rate weeks they can differ slightly. The choice here is
    // dictated by TC's existing back-office paystub convention
    // (rate × hours = full pay) — see handoff "Rate convention".
    const result = computeRegularRateOfPay({
      byShiftWithRates: [
        { hours: 30, rate: 20 },
        { hours: 20, rate: 25 },
      ],
    });
    expect(result.regularRateOfPay).toBe(22);
    expect(0.5 * result.regularRateOfPay).toBe(11);
    expect(1.5 * result.regularRateOfPay).toBe(33);
    expect(2 * result.regularRateOfPay).toBe(44);
  });
});
