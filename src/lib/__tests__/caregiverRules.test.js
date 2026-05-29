import { describe, it, expect } from 'vitest';
import {
  pickActiveRule,
  resolveCaregiverForDate,
  resolveCaregiverForInstance,
  resolveAssignmentForInstance,
  dayOfWeekFromDateString,
  activeRulesByDayOfWeek,
  planRuleUpsert,
  planRuleClear,
  previousDayString,
} from '../scheduling/caregiverRules';

// Small builder so each test reads as data, not setup. The defaults
// model the most common shape: open-ended rule starting in the past
// for Thursday (dow=4).
function rule(overrides = {}) {
  return {
    id: overrides.id ?? 'rule-' + Math.random().toString(36).slice(2, 8),
    service_plan_id: overrides.service_plan_id ?? 'plan-1',
    day_of_week: overrides.day_of_week ?? 4,
    caregiver_id: overrides.caregiver_id ?? 'cg-ciara',
    effective_from: overrides.effective_from ?? '2026-01-01',
    effective_to: overrides.effective_to ?? null,
  };
}

describe('pickActiveRule', () => {
  it('returns null for empty rules', () => {
    expect(pickActiveRule([], 4, '2026-05-14')).toBeNull();
    expect(pickActiveRule(null, 4, '2026-05-14')).toBeNull();
  });

  it('returns the rule when day_of_week and date both match', () => {
    const r = rule();
    const got = pickActiveRule([r], 4, '2026-05-14');
    expect(got).toBe(r);
  });

  it('ignores rules on a different day_of_week', () => {
    const r = rule({ day_of_week: 3 });
    expect(pickActiveRule([r], 4, '2026-05-14')).toBeNull();
  });

  it('ignores rules whose effective_from is after the date', () => {
    const r = rule({ effective_from: '2026-07-01' });
    expect(pickActiveRule([r], 4, '2026-05-14')).toBeNull();
  });

  it('ignores rules whose effective_to is before the date', () => {
    const r = rule({ effective_to: '2026-04-30' });
    expect(pickActiveRule([r], 4, '2026-05-14')).toBeNull();
  });

  it('includes rules whose effective range exactly matches the date', () => {
    const r = rule({ effective_from: '2026-05-14', effective_to: '2026-05-14' });
    expect(pickActiveRule([r], 4, '2026-05-14')).toBe(r);
  });

  it('successor rule wins over predecessor on the handoff date', () => {
    const ciara = rule({
      id: 'rule-ciara',
      caregiver_id: 'cg-ciara',
      effective_from: '2026-01-01',
      effective_to: '2026-06-30',
    });
    const maria = rule({
      id: 'rule-maria',
      caregiver_id: 'cg-maria',
      effective_from: '2026-07-01',
      effective_to: null,
    });
    expect(pickActiveRule([ciara, maria], 4, '2026-06-30').caregiver_id).toBe('cg-ciara');
    expect(pickActiveRule([ciara, maria], 4, '2026-07-01').caregiver_id).toBe('cg-maria');
    expect(pickActiveRule([ciara, maria], 4, '2026-12-25').caregiver_id).toBe('cg-maria');
  });

  it('most-recent effective_from wins on overlapping ranges', () => {
    const older = rule({ id: 'a', effective_from: '2026-01-01', effective_to: '2026-12-31' });
    const newer = rule({
      id: 'b',
      caregiver_id: 'cg-maria',
      effective_from: '2026-06-01',
    });
    expect(pickActiveRule([older, newer], 4, '2026-08-01').caregiver_id).toBe('cg-maria');
  });

  it('rejects malformed dates and dow', () => {
    expect(pickActiveRule([rule()], 'x', '2026-05-14')).toBeNull();
    expect(pickActiveRule([rule()], 4, '2026/05/14')).toBeNull();
    expect(pickActiveRule([rule()], -1, '2026-05-14')).toBeNull();
    expect(pickActiveRule([rule()], 7, '2026-05-14')).toBeNull();
  });
});

describe('resolveCaregiverForDate', () => {
  it('returns the caregiver_id of the active rule', () => {
    expect(resolveCaregiverForDate([rule()], 4, '2026-05-14')).toBe('cg-ciara');
  });

  it('returns null when nothing applies', () => {
    expect(resolveCaregiverForDate([rule()], 0, '2026-05-14')).toBeNull();
  });
});

describe('resolveCaregiverForInstance', () => {
  it('combines a dow resolver with the rule lookup', () => {
    const ciara = rule();
    const got = resolveCaregiverForInstance(
      { date: '2026-05-14', start_time: '2026-05-14T08:00:00Z' },
      [ciara],
      () => 4,
    );
    expect(got).toBe('cg-ciara');
  });

  it('returns null when the resolver returns a non-number', () => {
    const got = resolveCaregiverForInstance(
      { date: '2026-05-14' },
      [rule()],
      () => null,
    );
    expect(got).toBeNull();
  });
});

describe('activeRulesByDayOfWeek', () => {
  it('returns a slot per day, with active rules placed', () => {
    const thu = rule({ day_of_week: 4 });
    const fri = rule({ day_of_week: 5, caregiver_id: 'cg-bob' });
    const got = activeRulesByDayOfWeek([thu, fri], '2026-05-14');
    expect(got[0]).toBeNull();
    expect(got[4]).toBe(thu);
    expect(got[5]).toBe(fri);
    expect(got[6]).toBeNull();
  });
});

describe('planRuleUpsert', () => {
  it('returns a noop when the active rule already points to this caregiver', () => {
    const ciara = rule();
    const plan = planRuleUpsert({
      rules: [ciara],
      servicePlanId: 'plan-1',
      orgId: 'org-1',
      dayOfWeek: 4,
      caregiverId: 'cg-ciara',
      effectiveFrom: '2026-05-14',
    });
    expect(plan.noop).toBe(true);
    expect(plan.toExpire).toEqual([]);
    expect(plan.toInsert).toBeNull();
  });

  it('closes the prior rule and opens a new one when caregiver changes', () => {
    const ciara = rule({ id: 'ciara-rule' });
    const plan = planRuleUpsert({
      rules: [ciara],
      servicePlanId: 'plan-1',
      orgId: 'org-1',
      dayOfWeek: 4,
      caregiverId: 'cg-maria',
      effectiveFrom: '2026-07-02',
    });
    expect(plan.noop).toBe(false);
    expect(plan.toExpire).toEqual([{ id: 'ciara-rule', effective_to: '2026-07-01' }]);
    expect(plan.toInsert).toMatchObject({
      service_plan_id: 'plan-1',
      org_id: 'org-1',
      day_of_week: 4,
      caregiver_id: 'cg-maria',
      effective_from: '2026-07-02',
      effective_to: null,
    });
  });

  it('does not touch strictly-future-dated rules on a different day', () => {
    const futureFri = rule({
      id: 'fri-future',
      day_of_week: 5,
      effective_from: '2026-09-01',
    });
    const plan = planRuleUpsert({
      rules: [futureFri],
      servicePlanId: 'plan-1',
      orgId: 'org-1',
      dayOfWeek: 4,
      caregiverId: 'cg-maria',
      effectiveFrom: '2026-07-02',
    });
    expect(plan.toExpire).toEqual([]);
    expect(plan.toInsert).not.toBeNull();
  });

  it('does not touch strictly-future-dated rules on the same day', () => {
    // A future hand-off already planned (Sarah takes Thursdays Aug 1).
    // Setting Maria as today's regular shouldn't undo that.
    const futureSarah = rule({
      id: 'sarah-future',
      caregiver_id: 'cg-sarah',
      effective_from: '2026-08-01',
    });
    const plan = planRuleUpsert({
      rules: [futureSarah],
      servicePlanId: 'plan-1',
      orgId: 'org-1',
      dayOfWeek: 4,
      caregiverId: 'cg-maria',
      effectiveFrom: '2026-05-14',
    });
    expect(plan.toExpire).toEqual([]);
    expect(plan.toInsert.caregiver_id).toBe('cg-maria');
  });

  it('throws when required fields are missing', () => {
    expect(() =>
      planRuleUpsert({
        rules: [],
        servicePlanId: null,
        orgId: 'org-1',
        dayOfWeek: 4,
        caregiverId: 'cg-1',
        effectiveFrom: '2026-05-14',
      }),
    ).toThrow();
  });
});

describe('planRuleClear', () => {
  it('expires the currently-active rule', () => {
    const ciara = rule({ id: 'ciara-rule' });
    const plan = planRuleClear({
      rules: [ciara],
      dayOfWeek: 4,
      effectiveFrom: '2026-05-14',
    });
    expect(plan.toExpire).toEqual([{ id: 'ciara-rule', effective_to: '2026-05-13' }]);
    expect(plan.toInsert).toBeNull();
    expect(plan.noop).toBe(false);
  });

  it('is a noop when nothing is active', () => {
    const plan = planRuleClear({
      rules: [rule({ effective_to: '2025-12-31' })], // expired
      dayOfWeek: 4,
      effectiveFrom: '2026-05-14',
    });
    expect(plan.noop).toBe(true);
  });
});

describe('previousDayString', () => {
  it('subtracts one day', () => {
    expect(previousDayString('2026-05-14')).toBe('2026-05-13');
  });

  it('handles month rollover', () => {
    expect(previousDayString('2026-03-01')).toBe('2026-02-28');
  });

  it('handles leap year February', () => {
    expect(previousDayString('2024-03-01')).toBe('2024-02-29');
  });

  it('handles year rollover', () => {
    expect(previousDayString('2026-01-01')).toBe('2025-12-31');
  });

  it('throws on malformed input', () => {
    expect(() => previousDayString('not-a-date')).toThrow();
    expect(() => previousDayString('2026/05/14')).toThrow();
  });
});

describe('dayOfWeekFromDateString', () => {
  it('returns the correct weekday (0=Sun..6=Sat)', () => {
    // 2026-05-28 is a Thursday.
    expect(dayOfWeekFromDateString('2026-05-28')).toBe(4);
    // 2026-05-31 is a Sunday.
    expect(dayOfWeekFromDateString('2026-05-31')).toBe(0);
    // 2026-06-06 is a Saturday.
    expect(dayOfWeekFromDateString('2026-06-06')).toBe(6);
  });

  it('is timezone-stable — does not shift across UTC midnight', () => {
    // A naive `new Date('2026-05-28')` is UTC midnight; in a negative
    // offset zone .getDay() could read as the prior day. The helper
    // builds from parts so it always reports the literal calendar day.
    expect(dayOfWeekFromDateString('2026-01-01')).toBe(4); // Thursday
  });

  it('returns -1 for malformed or non-string input', () => {
    expect(dayOfWeekFromDateString('2026/05/28')).toBe(-1);
    expect(dayOfWeekFromDateString('not-a-date')).toBe(-1);
    expect(dayOfWeekFromDateString(null)).toBe(-1);
    expect(dayOfWeekFromDateString(undefined)).toBe(-1);
    expect(dayOfWeekFromDateString(20260528)).toBe(-1);
  });
});

describe('resolveAssignmentForInstance', () => {
  // 2026-05-28 is a Thursday (dow=4), matching the default rule builder.
  const thursdayInstance = { date: '2026-05-28', start_time: '2026-05-28T08:00:00.000Z' };

  it('confirms a matched caregiver', () => {
    const got = resolveAssignmentForInstance(thursdayInstance, [rule()]);
    expect(got).toEqual({ caregiverId: 'cg-ciara', status: 'confirmed' });
  });

  it('falls back to open + null when no rule matches the day', () => {
    // Rule is for Wednesday (dow=3), instance is Thursday.
    const got = resolveAssignmentForInstance(thursdayInstance, [rule({ day_of_week: 3 })]);
    expect(got).toEqual({ caregiverId: null, status: 'open' });
  });

  it('falls back to open with an empty rule set (pre-migration / no rules)', () => {
    expect(resolveAssignmentForInstance(thursdayInstance, [])).toEqual({
      caregiverId: null,
      status: 'open',
    });
  });

  it('falls back to open when the instance date is malformed', () => {
    const got = resolveAssignmentForInstance({ date: 'nope' }, [rule()]);
    expect(got).toEqual({ caregiverId: null, status: 'open' });
  });

  it('respects effective ranges — an expired rule does not confirm', () => {
    const got = resolveAssignmentForInstance(thursdayInstance, [
      rule({ effective_to: '2026-04-30' }),
    ]);
    expect(got).toEqual({ caregiverId: null, status: 'open' });
  });
});
