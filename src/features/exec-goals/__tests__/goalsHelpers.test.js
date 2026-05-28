import { describe, it, expect } from 'vitest';
import {
  quarterFromDate,
  quarterRange,
  isoDate,
  buildQuarterOptions,
  formatQuarterLabel,
  mondayOf,
  krProgress,
  validateGoalDraft,
  validateKrDraft,
  validateCheckinDraft,
  sortGoals,
  sortKrs,
  daysSince,
} from '../lib/goalsHelpers';

describe('quarterFromDate', () => {
  it('maps months 0-2 to Q1', () => {
    expect(quarterFromDate(new Date(2026, 0, 15))).toBe('2026-Q1');
    expect(quarterFromDate(new Date(2026, 2, 31))).toBe('2026-Q1');
  });
  it('maps months 3-5 to Q2', () => {
    expect(quarterFromDate(new Date(2026, 3, 1))).toBe('2026-Q2');
    expect(quarterFromDate(new Date(2026, 5, 30))).toBe('2026-Q2');
  });
  it('maps months 6-8 to Q3', () => {
    expect(quarterFromDate(new Date(2026, 6, 1))).toBe('2026-Q3');
  });
  it('maps months 9-11 to Q4', () => {
    expect(quarterFromDate(new Date(2026, 11, 31))).toBe('2026-Q4');
  });
  it('returns null on invalid date', () => {
    expect(quarterFromDate('not a date')).toBe(null);
  });
});

describe('quarterRange', () => {
  it('Q1 → Jan 1 .. Mar 31', () => {
    expect(quarterRange('2026-Q1')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
  });
  it('Q2 → Apr 1 .. Jun 30', () => {
    expect(quarterRange('2026-Q2')).toEqual({ start: '2026-04-01', end: '2026-06-30' });
  });
  it('Q3 → Jul 1 .. Sep 30', () => {
    expect(quarterRange('2026-Q3')).toEqual({ start: '2026-07-01', end: '2026-09-30' });
  });
  it('Q4 → Oct 1 .. Dec 31', () => {
    expect(quarterRange('2026-Q4')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
  });
  it('handles leap years correctly for Q1 end', () => {
    // Q1 2028 ends March 31, not affected by Feb 29 but worth verifying
    expect(quarterRange('2028-Q1').end).toBe('2028-03-31');
  });
  it('returns nulls on malformed input', () => {
    expect(quarterRange('2026-Q5')).toEqual({ start: null, end: null });
    expect(quarterRange('2026')).toEqual({ start: null, end: null });
    expect(quarterRange(null)).toEqual({ start: null, end: null });
  });
});

describe('isoDate', () => {
  it('formats a Date in local time', () => {
    expect(isoDate(new Date(2026, 4, 28))).toBe('2026-05-28');
  });
  it('returns null on invalid date', () => {
    expect(isoDate('garbage')).toBe(null);
  });
});

describe('buildQuarterOptions', () => {
  it('always includes current and next quarter', () => {
    const today = new Date(2026, 4, 15); // 2026-05 → Q2
    const opts = buildQuarterOptions([], today);
    expect(opts).toContain('2026-Q2');
    expect(opts).toContain('2026-Q3');
  });
  it('wraps year correctly when current quarter is Q4', () => {
    const today = new Date(2026, 11, 15); // Dec → Q4
    const opts = buildQuarterOptions([], today);
    expect(opts).toContain('2026-Q4');
    expect(opts).toContain('2027-Q1');
  });
  it('includes quarters from goals plus current', () => {
    const today = new Date(2026, 4, 15);
    const opts = buildQuarterOptions(
      [{ quarter: '2025-Q4' }, { quarter: '2026-Q1' }, { quarter: '2026-Q1' }],
      today,
    );
    expect(opts).toContain('2025-Q4');
    expect(opts).toContain('2026-Q1');
    expect(opts).toContain('2026-Q2');
  });
  it('sorts descending (newest first)', () => {
    const opts = buildQuarterOptions(
      [{ quarter: '2024-Q3' }, { quarter: '2025-Q2' }],
      new Date(2026, 0, 1),
    );
    // Should be [2026-Q2, 2026-Q1, 2025-Q2, 2024-Q3] — newest first
    expect(opts[0] > opts[opts.length - 1]).toBe(true);
  });
  it('dedupes repeated quarters', () => {
    const opts = buildQuarterOptions(
      [{ quarter: '2026-Q1' }, { quarter: '2026-Q1' }, { quarter: '2026-Q1' }],
      new Date(2026, 0, 15),
    );
    expect(opts.filter((q) => q === '2026-Q1').length).toBe(1);
  });
});

describe('formatQuarterLabel', () => {
  it('formats as "2026 Q2 (Apr–Jun)"', () => {
    expect(formatQuarterLabel('2026-Q2')).toBe('2026 Q2 (Apr–Jun)');
  });
  it('returns input on malformed quarter', () => {
    expect(formatQuarterLabel('garbage')).toBe('garbage');
    expect(formatQuarterLabel(null)).toBe('');
  });
});

describe('mondayOf', () => {
  it('on a Wednesday returns Monday of the same week', () => {
    expect(mondayOf(new Date(2026, 4, 27))).toBe('2026-05-25'); // Wed → Mon
  });
  it('on a Monday returns the same Monday', () => {
    expect(mondayOf(new Date(2026, 4, 25))).toBe('2026-05-25');
  });
  it('on a Sunday returns the prior Monday', () => {
    expect(mondayOf(new Date(2026, 4, 31))).toBe('2026-05-25'); // Sun → prior Mon
  });
  it('on a Saturday returns the prior Monday', () => {
    expect(mondayOf(new Date(2026, 4, 30))).toBe('2026-05-25');
  });
  it('handles month boundary', () => {
    // 2026-06-01 is a Monday
    expect(mondayOf(new Date(2026, 5, 3))).toBe('2026-06-01');
  });
  it('returns null on invalid', () => {
    expect(mondayOf('xyz')).toBe(null);
  });
});

describe('krProgress (increase)', () => {
  it('returns achieved when current >= target', () => {
    const r = krProgress({ start_value: 0, current_value: 100, target_value: 100, direction: 'increase' });
    expect(r.pct).toBe(1);
    expect(r.label).toBe('achieved');
    expect(r.achieved).toBe(true);
  });
  it('returns 0% when current === start', () => {
    const r = krProgress({ start_value: 10, current_value: 10, target_value: 20, direction: 'increase' });
    expect(r.pct).toBe(0);
    expect(r.label).toBe('not started');
  });
  it('returns 50% halfway', () => {
    const r = krProgress({ start_value: 0, current_value: 50, target_value: 100, direction: 'increase' });
    expect(r.pct).toBe(0.5);
    expect(r.label).toBe('behind');
  });
  it("returns 'on track' at 80%", () => {
    const r = krProgress({ start_value: 0, current_value: 80, target_value: 100, direction: 'increase' });
    expect(r.label).toBe('on track');
  });
  it('handles non-zero start (35 → 50 toward 100 = 23%)', () => {
    const r = krProgress({ start_value: 35, current_value: 50, target_value: 100, direction: 'increase' });
    expect(Math.round(r.pct * 100)).toBe(23);
  });
  it('exceeds 1.0 when stretch achieved', () => {
    const r = krProgress({ start_value: 0, current_value: 150, target_value: 100, direction: 'increase' });
    expect(r.pct).toBe(1.5);
    expect(r.achieved).toBe(true);
  });
});

describe('krProgress (decrease)', () => {
  it('achieved when current <= target', () => {
    const r = krProgress({ start_value: 100, current_value: 50, target_value: 50, direction: 'decrease' });
    expect(r.pct).toBe(1);
    expect(r.achieved).toBe(true);
  });
  it('halfway: turnover 38% → 31.5% toward 25%', () => {
    const r = krProgress({ start_value: 38, current_value: 31.5, target_value: 25, direction: 'decrease' });
    expect(Math.round(r.pct * 100)).toBe(50);
  });
  it('not started when current === start', () => {
    const r = krProgress({ start_value: 38, current_value: 38, target_value: 25, direction: 'decrease' });
    expect(r.pct).toBe(0);
    expect(r.label).toBe('not started');
  });
});

describe('krProgress (edge cases)', () => {
  it('returns null on missing kr', () => {
    expect(krProgress(null).pct).toBe(null);
  });
  it('returns null on missing target', () => {
    expect(krProgress({ start_value: 0, current_value: 0 }).pct).toBe(null);
  });
});

describe('validateGoalDraft', () => {
  const valid = {
    title: 'Top-rated agency',
    owner_email: 'kevin@tc.com',
    quarter: '2026-Q2',
    start_date: '2026-04-01',
    end_date: '2026-06-30',
  };
  it('accepts a fully valid draft', () => {
    expect(validateGoalDraft(valid).ok).toBe(true);
  });
  it('rejects empty title', () => {
    expect(validateGoalDraft({ ...valid, title: '   ' }).ok).toBe(false);
  });
  it('rejects missing owner_email', () => {
    expect(validateGoalDraft({ ...valid, owner_email: 'notanemail' }).ok).toBe(false);
  });
  it('rejects malformed quarter', () => {
    expect(validateGoalDraft({ ...valid, quarter: '2026' }).ok).toBe(false);
    expect(validateGoalDraft({ ...valid, quarter: '2026-Q5' }).ok).toBe(false);
  });
  it('rejects end_date before start_date', () => {
    expect(validateGoalDraft({ ...valid, start_date: '2026-04-15', end_date: '2026-04-01' }).ok).toBe(false);
  });
  it('rejects invalid status', () => {
    expect(validateGoalDraft({ ...valid, status: 'foo' }).ok).toBe(false);
  });
  it('accepts all valid statuses', () => {
    ['draft', 'active', 'achieved', 'missed', 'cancelled'].forEach((st) => {
      expect(validateGoalDraft({ ...valid, status: st }).ok).toBe(true);
    });
  });
});

describe('validateKrDraft', () => {
  const valid = {
    goal_id: 'goal-uuid',
    title: 'Hit 4.8★ rating',
    owner_email: 'kevin@tc.com',
    metric_unit: 'rating',
    direction: 'increase',
    target_value: 4.8,
    start_value: 4.2,
  };
  it('accepts a fully valid draft', () => {
    expect(validateKrDraft(valid).ok).toBe(true);
  });
  it('rejects missing goal_id', () => {
    expect(validateKrDraft({ ...valid, goal_id: null }).ok).toBe(false);
  });
  it('rejects non-number target', () => {
    expect(validateKrDraft({ ...valid, target_value: 'foo' }).ok).toBe(false);
  });
  it('treats empty start_value as 0 (passes)', () => {
    expect(validateKrDraft({ ...valid, start_value: '' }).ok).toBe(true);
  });
  it('rejects invalid metric_unit', () => {
    expect(validateKrDraft({ ...valid, metric_unit: 'wat' }).ok).toBe(false);
  });
  it('rejects invalid direction', () => {
    expect(validateKrDraft({ ...valid, direction: 'sideways' }).ok).toBe(false);
  });
});

describe('validateCheckinDraft', () => {
  const valid = {
    key_result_id: 'kr-uuid',
    week_of: '2026-05-25',
    value: 4.5,
    confidence: 'green',
    author: 'kevin@tc.com',
  };
  it('accepts a fully valid draft', () => {
    expect(validateCheckinDraft(valid).ok).toBe(true);
  });
  it('rejects missing key_result_id', () => {
    expect(validateCheckinDraft({ ...valid, key_result_id: null }).ok).toBe(false);
  });
  it('rejects malformed week_of', () => {
    expect(validateCheckinDraft({ ...valid, week_of: '2026/05/25' }).ok).toBe(false);
    expect(validateCheckinDraft({ ...valid, week_of: 'today' }).ok).toBe(false);
  });
  it('rejects non-number value', () => {
    expect(validateCheckinDraft({ ...valid, value: 'high' }).ok).toBe(false);
  });
  it('rejects invalid confidence', () => {
    expect(validateCheckinDraft({ ...valid, confidence: 'purple' }).ok).toBe(false);
  });
  it('rejects missing author', () => {
    expect(validateCheckinDraft({ ...valid, author: null }).ok).toBe(false);
  });
});

describe('sort helpers', () => {
  it('sortGoals: sort_order ascending then created_at', () => {
    const goals = [
      { id: 'a', sort_order: 2, created_at: '2026-05-01' },
      { id: 'b', sort_order: 1, created_at: '2026-05-03' },
      { id: 'c', sort_order: 1, created_at: '2026-05-02' },
    ];
    expect(sortGoals(goals).map((g) => g.id)).toEqual(['c', 'b', 'a']);
  });
  it('sortKrs: same ordering rule as sortGoals', () => {
    const krs = [
      { id: 'a', sort_order: 10, created_at: '2026-05-01' },
      { id: 'b', sort_order: 0, created_at: '2026-05-03' },
    ];
    expect(sortKrs(krs).map((k) => k.id)).toEqual(['b', 'a']);
  });
});

describe('daysSince', () => {
  it('returns 0 when timestamp is now', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    expect(daysSince(now.toISOString(), now)).toBe(0);
  });
  it('returns 5 when timestamp is 5 days ago', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    const past = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    expect(daysSince(past.toISOString(), now)).toBe(5);
  });
  it('returns null on missing/invalid', () => {
    expect(daysSince(null)).toBe(null);
    expect(daysSince('garbage')).toBe(null);
  });
});
