import { describe, it, expect } from 'vitest';
import {
  clockToMinutes,
  clockRangesOverlap,
  dateRangesOverlap,
  findRuleConflicts,
  findShiftConflicts,
} from '../scheduling/ruleConflicts';

describe('clockToMinutes', () => {
  it('parses HH:MM', () => {
    expect(clockToMinutes('00:00')).toBe(0);
    expect(clockToMinutes('08:30')).toBe(510);
    expect(clockToMinutes('23:59')).toBe(1439);
  });
  it('rejects malformed input', () => {
    expect(clockToMinutes('8:30')).toBe(510); // single-digit hour allowed
    expect(clockToMinutes('abc')).toBeNull();
    expect(clockToMinutes(null)).toBeNull();
    expect(clockToMinutes('25:00')).toBeNull();
    expect(clockToMinutes('08:60')).toBeNull();
  });
});

describe('clockRangesOverlap', () => {
  it('returns true for overlapping ranges', () => {
    expect(clockRangesOverlap(0, 600, 300, 900)).toBe(true);
  });
  it('returns false for non-overlapping ranges', () => {
    expect(clockRangesOverlap(0, 300, 600, 900)).toBe(false);
  });
  it('touching edges do not overlap', () => {
    expect(clockRangesOverlap(0, 300, 300, 600)).toBe(false);
  });
  it('handles overnight wrap (a wraps midnight)', () => {
    // 22:00 → 06:00 vs 04:00 → 10:00
    expect(clockRangesOverlap(22 * 60, 6 * 60, 4 * 60, 10 * 60)).toBe(true);
    // 22:00 → 06:00 vs 10:00 → 16:00
    expect(clockRangesOverlap(22 * 60, 6 * 60, 10 * 60, 16 * 60)).toBe(false);
  });
  it('handles overnight wrap (b wraps midnight)', () => {
    expect(clockRangesOverlap(4 * 60, 10 * 60, 22 * 60, 6 * 60)).toBe(true);
  });
});

describe('dateRangesOverlap', () => {
  it('returns true when ranges overlap', () => {
    expect(dateRangesOverlap('2026-05-01', '2026-05-31', '2026-05-15', null)).toBe(true);
  });
  it('returns false when a ends before b starts', () => {
    expect(dateRangesOverlap('2026-04-01', '2026-04-30', '2026-05-01', null)).toBe(false);
  });
  it('returns false when b ends before a starts', () => {
    expect(dateRangesOverlap('2026-05-01', null, '2026-03-01', '2026-04-15')).toBe(false);
  });
  it('treats null effective_to as open-ended', () => {
    expect(dateRangesOverlap('2026-01-01', null, '2030-01-01', null)).toBe(true);
  });
});

describe('findRuleConflicts', () => {
  function ruleWithPattern(o = {}) {
    return {
      id: o.id ?? 'rule-x',
      service_plan_id: o.service_plan_id ?? 'plan-other',
      day_of_week: o.day_of_week ?? 4,
      caregiver_id: o.caregiver_id ?? 'cg-maria',
      effective_from: o.effective_from ?? '2026-01-01',
      effective_to: o.effective_to ?? null,
      pattern_start_clock: o.pattern_start_clock ?? '18:00',
      pattern_end_clock: o.pattern_end_clock ?? '22:00',
    };
  }

  const proposed = {
    caregiverId: 'cg-maria',
    servicePlanId: 'plan-this',
    dayOfWeek: 4,
    startClock: '18:00',
    endClock: '22:00',
    effectiveFrom: '2026-05-14',
    effectiveTo: null,
  };

  it('flags an overlapping rule for the same caregiver on a different plan', () => {
    const existing = ruleWithPattern();
    expect(findRuleConflicts(proposed, [existing])).toEqual([existing]);
  });

  it('ignores rules on the same service plan (handled by upsert logic)', () => {
    const existing = ruleWithPattern({ service_plan_id: 'plan-this' });
    expect(findRuleConflicts(proposed, [existing])).toEqual([]);
  });

  it('ignores rules on a different day', () => {
    expect(findRuleConflicts(proposed, [ruleWithPattern({ day_of_week: 3 })])).toEqual([]);
  });

  it('ignores rules for a different caregiver', () => {
    expect(
      findRuleConflicts(proposed, [ruleWithPattern({ caregiver_id: 'cg-bob' })]),
    ).toEqual([]);
  });

  it('ignores rules whose effective range does not overlap', () => {
    expect(
      findRuleConflicts(proposed, [
        ruleWithPattern({ effective_to: '2026-04-30' }),
      ]),
    ).toEqual([]);
  });

  it('ignores rules whose clock window does not overlap', () => {
    expect(
      findRuleConflicts(proposed, [
        ruleWithPattern({ pattern_start_clock: '09:00', pattern_end_clock: '12:00' }),
      ]),
    ).toEqual([]);
  });

  it('returns [] for malformed proposed times', () => {
    expect(
      findRuleConflicts(
        { ...proposed, startClock: 'bad', endClock: '22:00' },
        [ruleWithPattern()],
      ),
    ).toEqual([]);
  });
});

describe('findShiftConflicts', () => {
  const proposed = {
    caregiverId: 'cg-maria',
    servicePlanId: 'plan-this',
    dayOfWeek: 4, // Thursday — 2026-05-14 is a Thursday
    startClock: '18:00',
    endClock: '22:00',
    effectiveFrom: '2026-05-01',
    effectiveTo: null,
  };

  function shift(o = {}) {
    return {
      id: o.id ?? 's1',
      start_time: o.start_time ?? '2026-05-14T18:00:00Z',
      end_time: o.end_time ?? '2026-05-14T22:00:00Z',
      status: o.status ?? 'assigned',
      service_plan_id: o.service_plan_id ?? 'plan-other',
    };
  }

  it('flags an overlapping shift on a matching weekday in range', () => {
    const s = shift();
    expect(findShiftConflicts(proposed, [s])).toEqual([s]);
  });

  it('ignores shifts before effectiveFrom', () => {
    expect(
      findShiftConflicts(proposed, [shift({ start_time: '2026-04-23T18:00:00Z', end_time: '2026-04-23T22:00:00Z' })]),
    ).toEqual([]);
  });

  it('ignores cancelled / completed / no_show shifts', () => {
    expect(findShiftConflicts(proposed, [shift({ status: 'cancelled' })])).toEqual([]);
    expect(findShiftConflicts(proposed, [shift({ status: 'completed' })])).toEqual([]);
    expect(findShiftConflicts(proposed, [shift({ status: 'no_show' })])).toEqual([]);
  });

  it('ignores shifts on a different weekday', () => {
    // 2026-05-15 is a Friday (dow=5)
    expect(
      findShiftConflicts(proposed, [
        shift({ start_time: '2026-05-15T18:00:00Z', end_time: '2026-05-15T22:00:00Z' }),
      ]),
    ).toEqual([]);
  });

  it('ignores shifts that do not overlap the clock window', () => {
    expect(
      findShiftConflicts(proposed, [
        shift({ start_time: '2026-05-14T08:00:00Z', end_time: '2026-05-14T12:00:00Z' }),
      ]),
    ).toEqual([]);
  });
});
