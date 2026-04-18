import { describe, it, expect } from 'vitest';
import { EMPLOYMENT_STATUSES, AVAILABILITY_TYPES } from '../constants';
import {
  getExpiryStatus,
  getRosterCaregivers,
  getOnboardingCaregivers,
  getSchedulableCaregivers,
  isOnboardingCaregiver,
} from '../rosterUtils';

// ─── Constants tests ───

describe('EMPLOYMENT_STATUSES', () => {
  it('has 5 statuses', () => {
    expect(EMPLOYMENT_STATUSES).toHaveLength(5);
  });

  it('includes onboarding as first status', () => {
    expect(EMPLOYMENT_STATUSES[0].id).toBe('onboarding');
  });

  it('includes active status', () => {
    expect(EMPLOYMENT_STATUSES.find((s) => s.id === 'active')).toBeDefined();
  });

  it('each status has id, label, color, bg', () => {
    for (const s of EMPLOYMENT_STATUSES) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('label');
      expect(s).toHaveProperty('color');
      expect(s).toHaveProperty('bg');
    }
  });
});

describe('AVAILABILITY_TYPES', () => {
  it('has 4 types', () => {
    expect(AVAILABILITY_TYPES).toHaveLength(4);
  });

  it('each type has id and label', () => {
    for (const t of AVAILABILITY_TYPES) {
      expect(t).toHaveProperty('id');
      expect(t).toHaveProperty('label');
    }
  });
});

// ─── getExpiryStatus tests ───

describe('getExpiryStatus', () => {
  it('returns "Not set" for null input', () => {
    const result = getExpiryStatus(null);
    expect(result.level).toBe('none');
    expect(result.label).toBe('Not set');
  });

  it('returns expired for past dates', () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 30);
    const dateStr = pastDate.toISOString().split('T')[0];
    const result = getExpiryStatus(dateStr);
    expect(result.level).toBe('expired');
    expect(result.color).toBe('#DC2626');
  });

  it('returns warning for dates within 90 days', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 45);
    const dateStr = soon.toISOString().split('T')[0];
    const result = getExpiryStatus(dateStr);
    expect(result.level).toBe('warning');
    expect(result.color).toBe('#D97706');
  });

  it('returns ok for dates more than 90 days out', () => {
    const far = new Date();
    far.setDate(far.getDate() + 180);
    const dateStr = far.toISOString().split('T')[0];
    const result = getExpiryStatus(dateStr);
    expect(result.level).toBe('ok');
    expect(result.color).toBe('#15803D');
  });
});

// ─── Filtering tests ───

describe('getRosterCaregivers', () => {
  const caregivers = [
    { id: '1', archived: false, employmentStatus: 'active' },
    { id: '2', archived: false, employmentStatus: 'onboarding' },
    { id: '3', archived: true, employmentStatus: 'active' },
    { id: '4', archived: false, employmentStatus: 'on_leave' },
    { id: '5', archived: false },
  ];

  it('returns only non-archived, non-onboarding caregivers', () => {
    const result = getRosterCaregivers(caregivers);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(['1', '4']);
  });

  it('excludes archived caregivers even if status is active', () => {
    const result = getRosterCaregivers(caregivers);
    expect(result.find((c) => c.id === '3')).toBeUndefined();
  });
});

describe('getOnboardingCaregivers', () => {
  const caregivers = [
    { id: '1', archived: false, employmentStatus: 'active' },
    { id: '2', archived: false, employmentStatus: 'onboarding' },
    { id: '3', archived: true, employmentStatus: 'onboarding' },
    { id: '4', archived: false },
  ];

  it('returns non-archived caregivers with onboarding or no status', () => {
    const result = getOnboardingCaregivers(caregivers);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(['2', '4']);
  });
});

describe('getSchedulableCaregivers', () => {
  const caregivers = [
    { id: '1', archived: false, employmentStatus: 'active' },
    { id: '2', archived: false, employmentStatus: 'onboarding' },
    { id: '3', archived: true, employmentStatus: 'active' },
    { id: '4', archived: false, employmentStatus: 'on_leave' },
    { id: '5', archived: false },
    { id: '6', archived: true, employmentStatus: 'onboarding' },
  ];

  it('includes active roster (any non-onboarding status) and onboarding applicants', () => {
    const result = getSchedulableCaregivers(caregivers);
    expect(result.map((c) => c.id).sort()).toEqual(['1', '2', '4', '5']);
  });

  it('lists roster caregivers before onboarding applicants', () => {
    const result = getSchedulableCaregivers(caregivers);
    const ids = result.map((c) => c.id);
    expect(ids.indexOf('1')).toBeLessThan(ids.indexOf('2'));
    expect(ids.indexOf('4')).toBeLessThan(ids.indexOf('5'));
  });

  it('excludes archived caregivers regardless of status', () => {
    const result = getSchedulableCaregivers(caregivers);
    const ids = result.map((c) => c.id);
    expect(ids).not.toContain('3');
    expect(ids).not.toContain('6');
  });
});

describe('isOnboardingCaregiver', () => {
  it('is true for a caregiver with employmentStatus "onboarding"', () => {
    expect(isOnboardingCaregiver({ archived: false, employmentStatus: 'onboarding' })).toBe(true);
  });

  it('is true when employmentStatus is missing entirely', () => {
    expect(isOnboardingCaregiver({ archived: false })).toBe(true);
  });

  it('is false for active roster caregivers', () => {
    expect(isOnboardingCaregiver({ archived: false, employmentStatus: 'active' })).toBe(false);
    expect(isOnboardingCaregiver({ archived: false, employmentStatus: 'on_leave' })).toBe(false);
  });

  it('is false for archived caregivers even if status is onboarding', () => {
    expect(isOnboardingCaregiver({ archived: true, employmentStatus: 'onboarding' })).toBe(false);
  });

  it('is false for nullish input', () => {
    expect(isOnboardingCaregiver(null)).toBe(false);
    expect(isOnboardingCaregiver(undefined)).toBe(false);
  });
});
