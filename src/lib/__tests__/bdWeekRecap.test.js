import { describe, it, expect } from 'vitest';
import {
  localIsoDate,
  localIsoDateFromTimestamp,
  addDaysIso,
  getWeekRange,
  formatShortDay,
  formatShortDate,
  formatDayHeader,
  formatWeekRange,
  groupActivitiesByDay,
  groupPlansByDay,
  matchPlanToActuals,
  computeDayCounters,
  computeDaySummary,
  computeWeekSummary,
  noonLocalInputForIsoDate,
} from '../../features/bd-portal/lib/bdWeekRecap';

// ─── Date math ────────────────────────────────────────────────────

describe('localIsoDate', () => {
  it('uses local fields (not UTC)', () => {
    // Late-evening local date should not roll forward to UTC tomorrow.
    const d = new Date(2026, 4, 13, 23, 30);
    expect(localIsoDate(d)).toBe('2026-05-13');
  });

  it('zero-pads month and day', () => {
    expect(localIsoDate(new Date(2026, 0, 3))).toBe('2026-01-03');
  });
});

describe('addDaysIso', () => {
  it('handles same-month addition', () => {
    expect(addDaysIso('2026-05-18', 6)).toBe('2026-05-24');
  });

  it('crosses month boundaries', () => {
    expect(addDaysIso('2026-04-28', 7)).toBe('2026-05-05');
  });

  it('crosses year boundaries', () => {
    expect(addDaysIso('2025-12-30', 5)).toBe('2026-01-04');
  });

  it('handles negative offsets', () => {
    expect(addDaysIso('2026-05-04', -3)).toBe('2026-05-01');
  });
});

describe('getWeekRange', () => {
  it('returns Mon–Sun when given a Wednesday', () => {
    const wed = new Date(2026, 4, 20); // Wed May 20 2026
    const { start, end, dates } = getWeekRange(wed);
    expect(start).toBe('2026-05-18');
    expect(end).toBe('2026-05-24');
    expect(dates).toEqual([
      '2026-05-18', '2026-05-19', '2026-05-20',
      '2026-05-21', '2026-05-22', '2026-05-23', '2026-05-24',
    ]);
  });

  it('returns the same week when given the Monday itself', () => {
    const mon = new Date(2026, 4, 18); // Mon May 18 2026
    const { start, end } = getWeekRange(mon);
    expect(start).toBe('2026-05-18');
    expect(end).toBe('2026-05-24');
  });

  it('treats Sunday as the LAST day of the prior Mon–Sun week', () => {
    // Sun May 24 2026 → the week is Mon May 18 – Sun May 24.
    const sun = new Date(2026, 4, 24);
    const { start, end } = getWeekRange(sun);
    expect(start).toBe('2026-05-18');
    expect(end).toBe('2026-05-24');
  });

  it('spans month boundaries cleanly', () => {
    // Wed Apr 29 2026 → Mon Apr 27 – Sun May 3.
    const wed = new Date(2026, 3, 29);
    const { dates } = getWeekRange(wed);
    expect(dates[0]).toBe('2026-04-27');
    expect(dates[6]).toBe('2026-05-03');
  });
});

// ─── Display helpers ──────────────────────────────────────────────

describe('formatShortDay', () => {
  it('returns 3-letter day names', () => {
    expect(formatShortDay('2026-05-18')).toBe('Mon');
    expect(formatShortDay('2026-05-24')).toBe('Sun');
  });
});

describe('formatShortDate', () => {
  it('returns "MMM D"', () => {
    expect(formatShortDate('2026-05-18')).toBe('May 18');
    expect(formatShortDate('2026-01-03')).toBe('Jan 3');
  });
});

describe('formatDayHeader', () => {
  it('returns "Weekday, MMM D"', () => {
    expect(formatDayHeader('2026-05-20')).toBe('Wednesday, May 20');
  });
});

describe('formatWeekRange', () => {
  it('collapses same-month ranges', () => {
    expect(formatWeekRange({ start: '2026-05-18', end: '2026-05-24' }))
      .toBe('May 18 – 24, 2026');
  });

  it('expands cross-month ranges', () => {
    expect(formatWeekRange({ start: '2026-04-27', end: '2026-05-03' }))
      .toBe('Apr 27 – May 3, 2026');
  });
});

// ─── Bucketing ────────────────────────────────────────────────────

describe('groupActivitiesByDay', () => {
  const weekDates = [
    '2026-05-18', '2026-05-19', '2026-05-20',
    '2026-05-21', '2026-05-22', '2026-05-23', '2026-05-24',
  ];

  it('buckets activities by their local-time occurred_at date', () => {
    const acts = [
      { id: 'a', occurred_at: '2026-05-18T15:30:00Z' },
      { id: 'b', occurred_at: '2026-05-20T10:00:00Z' },
      { id: 'c', occurred_at: '2026-05-20T19:00:00Z' },
    ];
    const out = groupActivitiesByDay(acts, weekDates);
    expect(out.get('2026-05-18').map((a) => a.id)).toEqual(['a']);
    expect(out.get('2026-05-20').map((a) => a.id)).toEqual(['b', 'c']);
    expect(out.get('2026-05-19')).toEqual([]);
  });

  it('drops activities outside the week window', () => {
    const acts = [
      { id: 'x', occurred_at: '2026-05-11T10:00:00Z' },
      { id: 'y', occurred_at: '2026-05-25T10:00:00Z' },
    ];
    const out = groupActivitiesByDay(acts, weekDates);
    let total = 0;
    for (const list of out.values()) total += list.length;
    expect(total).toBe(0);
  });

  it('orders activities within a day chronologically', () => {
    const acts = [
      { id: 'late',  occurred_at: '2026-05-20T20:00:00Z' },
      { id: 'early', occurred_at: '2026-05-20T08:00:00Z' },
      { id: 'mid',   occurred_at: '2026-05-20T13:00:00Z' },
    ];
    const out = groupActivitiesByDay(acts, weekDates);
    expect(out.get('2026-05-20').map((a) => a.id)).toEqual(['early', 'mid', 'late']);
  });

  it('handles empty input arrays', () => {
    const out = groupActivitiesByDay([], weekDates);
    expect(out.size).toBe(7);
    for (const list of out.values()) expect(list).toEqual([]);
  });
});

describe('groupPlansByDay', () => {
  it('indexes by plan_date and ignores archived plans', () => {
    const plans = [
      { id: 'p1', plan_date: '2026-05-18', status: 'active',   stops: [] },
      { id: 'p2', plan_date: '2026-05-19', status: 'archived', stops: [] },
      { id: 'p3', plan_date: '2026-05-20', status: 'active',   stops: [{ account_id: 'a1' }] },
    ];
    const out = groupPlansByDay(plans);
    expect(out.get('2026-05-18').id).toBe('p1');
    expect(out.has('2026-05-19')).toBe(false);
    expect(out.get('2026-05-20').stops).toHaveLength(1);
  });
});

// ─── Plan vs actual ───────────────────────────────────────────────

describe('matchPlanToActuals', () => {
  it('marks planned stops with matching activities as completed', () => {
    const stops = [
      { account_id: 'a1', position: 0 },
      { account_id: 'a2', position: 1 },
    ];
    const acts = [
      { id: 'x', account_id: 'a1', activity_type: 'visit',    occurred_at: '2026-05-20T10:00:00Z' },
      { id: 'y', account_id: 'a1', activity_type: 'drop_off', occurred_at: '2026-05-20T10:30:00Z' },
    ];
    const { planned, unplanned } = matchPlanToActuals(stops, acts);
    expect(planned).toHaveLength(2);
    expect(planned[0]).toMatchObject({ account_id: 'a1', completed: true });
    expect(planned[0].activities).toHaveLength(2);
    expect(planned[1]).toMatchObject({ account_id: 'a2', completed: false });
    expect(planned[1].activities).toEqual([]);
    expect(unplanned).toEqual([]);
  });

  it('returns activities against non-planned accounts as unplanned', () => {
    const stops = [{ account_id: 'a1', position: 0 }];
    const acts = [
      { id: 'x', account_id: 'a1', occurred_at: '2026-05-20T10:00:00Z' },
      { id: 'y', account_id: 'a9', occurred_at: '2026-05-20T11:00:00Z' },
    ];
    const { planned, unplanned } = matchPlanToActuals(stops, acts);
    expect(planned[0].completed).toBe(true);
    expect(unplanned.map((a) => a.id)).toEqual(['y']);
  });

  it('handles an empty plan (all activities are unplanned)', () => {
    const acts = [
      { id: 'x', account_id: 'a1' },
      { id: 'y', account_id: 'a2' },
    ];
    const { planned, unplanned } = matchPlanToActuals([], acts);
    expect(planned).toEqual([]);
    expect(unplanned).toHaveLength(2);
  });

  it('handles an empty activities list (all stops missed)', () => {
    const stops = [
      { account_id: 'a1', position: 0 },
      { account_id: 'a2', position: 1 },
    ];
    const { planned, unplanned } = matchPlanToActuals(stops, []);
    expect(planned.every((p) => !p.completed)).toBe(true);
    expect(unplanned).toEqual([]);
  });

  it('preserves the plan stop order', () => {
    const stops = [
      { account_id: 'c', position: 0 },
      { account_id: 'a', position: 1 },
      { account_id: 'b', position: 2 },
    ];
    const { planned } = matchPlanToActuals(stops, []);
    expect(planned.map((p) => p.account_id)).toEqual(['c', 'a', 'b']);
  });
});

// ─── Counters ─────────────────────────────────────────────────────

describe('computeDayCounters', () => {
  it('buckets activities by activity_type', () => {
    const acts = [
      { activity_type: 'visit' },
      { activity_type: 'visit' },
      { activity_type: 'call' },
      { activity_type: 'drop_off' },
      { activity_type: 'email' },
      { activity_type: 'note' },
    ];
    const c = computeDayCounters(acts);
    expect(c.visits).toBe(2);
    expect(c.calls).toBe(1);
    expect(c.dropOffs).toBe(1);
    expect(c.emails).toBe(1);
    expect(c.notes).toBe(1);
    expect(c.total).toBe(6);
  });

  it('routes unknown activity types into `other`', () => {
    const c = computeDayCounters([{ activity_type: 'mystery' }]);
    expect(c.other).toBe(1);
    expect(c.total).toBe(1);
  });

  it('returns zeros for empty input', () => {
    const c = computeDayCounters([]);
    expect(c.total).toBe(0);
    expect(c.visits).toBe(0);
  });
});

// ─── Day + week summary ───────────────────────────────────────────

describe('computeDaySummary', () => {
  it('combines plan-vs-actual with counters', () => {
    const plan = { stops: [
      { account_id: 'a1', position: 0 },
      { account_id: 'a2', position: 1 },
      { account_id: 'a3', position: 2 },
    ] };
    const acts = [
      { account_id: 'a1', activity_type: 'visit', occurred_at: '2026-05-20T10:00:00Z' },
      { account_id: 'a3', activity_type: 'call',  occurred_at: '2026-05-20T14:00:00Z' },
      { account_id: 'a9', activity_type: 'visit', occurred_at: '2026-05-20T15:00:00Z' },
    ];
    const s = computeDaySummary({ plan, activities: acts });
    expect(s.planTotal).toBe(3);
    expect(s.planCompleted).toBe(2);
    expect(s.planMissed).toBe(1);
    expect(s.unplannedCount).toBe(1);
    expect(s.counters.visits).toBe(2);
    expect(s.counters.calls).toBe(1);
  });

  it('handles "no plan that day" gracefully', () => {
    const acts = [{ account_id: 'a1', activity_type: 'visit', occurred_at: '2026-05-20T10:00:00Z' }];
    const s = computeDaySummary({ plan: null, activities: acts });
    expect(s.planTotal).toBe(0);
    expect(s.planCompleted).toBe(0);
    expect(s.planMissed).toBe(0);
    expect(s.unplannedCount).toBe(1);
  });
});

describe('computeWeekSummary', () => {
  const weekDates = [
    '2026-05-18', '2026-05-19', '2026-05-20',
    '2026-05-21', '2026-05-22', '2026-05-23', '2026-05-24',
  ];

  it('rolls up planned/completed/missed and totals across the week', () => {
    const plans = [
      { plan_date: '2026-05-18', status: 'active', stops: [{ account_id: 'a1', position: 0 }, { account_id: 'a2', position: 1 }] },
      { plan_date: '2026-05-20', status: 'active', stops: [{ account_id: 'a3', position: 0 }] },
    ];
    const acts = [
      { account_id: 'a1', activity_type: 'visit', occurred_at: '2026-05-18T16:00:00Z', spend_cents: 0    },
      { account_id: 'a3', activity_type: 'visit', occurred_at: '2026-05-20T17:00:00Z', spend_cents: 1500 },
      { account_id: 'a4', activity_type: 'call',  occurred_at: '2026-05-22T17:00:00Z', spend_cents: 0    },
    ];
    const w = computeWeekSummary({ plans, activities: acts, weekDates });
    // Planned: a1 + a2 + a3 = 3. Completed: a1 + a3 = 2.
    expect(w.totalPlanned).toBe(3);
    expect(w.totalCompleted).toBe(2);
    expect(w.totalMissed).toBe(1);
    expect(w.totalActivities).toBe(3);
    expect(w.totalsByType.visits).toBe(2);
    expect(w.totalsByType.calls).toBe(1);
    expect(w.totalAccountsTouched).toBe(3);
    expect(w.totalSpendCents).toBe(1500);
  });

  it('returns zeroed totals for an empty week', () => {
    const w = computeWeekSummary({ plans: [], activities: [], weekDates });
    expect(w.totalPlanned).toBe(0);
    expect(w.totalActivities).toBe(0);
    expect(w.totalAccountsTouched).toBe(0);
  });
});

// ─── Misc ─────────────────────────────────────────────────────────

describe('localIsoDateFromTimestamp', () => {
  it('returns null for null/undefined/invalid input', () => {
    expect(localIsoDateFromTimestamp(null)).toBe(null);
    expect(localIsoDateFromTimestamp(undefined)).toBe(null);
    expect(localIsoDateFromTimestamp('not a date')).toBe(null);
  });
});

describe('noonLocalInputForIsoDate', () => {
  it('returns a 12:00 datetime-local string', () => {
    expect(noonLocalInputForIsoDate('2026-05-20')).toBe('2026-05-20T12:00');
  });

  it('returns null for falsy input', () => {
    expect(noonLocalInputForIsoDate(null)).toBe(null);
    expect(noonLocalInputForIsoDate('')).toBe(null);
  });
});
