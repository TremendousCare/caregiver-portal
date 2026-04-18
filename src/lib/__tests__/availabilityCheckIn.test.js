import { describe, it, expect } from 'vitest';
import {
  isActiveForAvailabilityCheckIn,
  matchesPhaseFilter,
  filterActiveCaregiversForCheckIn,
  isDueForAvailabilityCheck,
  isValidAvailabilityTemplate,
  isWithinSendWindow,
} from '../scheduling/availabilityCheckIn';

describe('isActiveForAvailabilityCheckIn', () => {
  it('treats a vanilla caregiver as active', () => {
    expect(
      isActiveForAvailabilityCheckIn({ archived: false }),
    ).toBe(true);
  });

  it('blocks archived caregivers', () => {
    expect(
      isActiveForAvailabilityCheckIn({ archived: true }),
    ).toBe(false);
  });

  it('blocks globally opted-out caregivers (camelCase)', () => {
    expect(
      isActiveForAvailabilityCheckIn({ archived: false, smsOptedOut: true }),
    ).toBe(false);
  });

  it('blocks globally opted-out caregivers (snake_case)', () => {
    expect(
      isActiveForAvailabilityCheckIn({ archived: false, sms_opted_out: true }),
    ).toBe(false);
  });

  it('blocks availability-paused caregivers (camelCase)', () => {
    expect(
      isActiveForAvailabilityCheckIn({
        archived: false,
        availabilityCheckPaused: true,
      }),
    ).toBe(false);
  });

  it('blocks availability-paused caregivers (snake_case)', () => {
    expect(
      isActiveForAvailabilityCheckIn({
        archived: false,
        availability_check_paused: true,
      }),
    ).toBe(false);
  });

  it('returns false for missing / invalid input', () => {
    expect(isActiveForAvailabilityCheckIn(null)).toBe(false);
    expect(isActiveForAvailabilityCheckIn(undefined)).toBe(false);
  });
});

describe('matchesPhaseFilter', () => {
  it('returns true when no filter is set', () => {
    expect(matchesPhaseFilter('intake', null)).toBe(true);
    expect(matchesPhaseFilter('intake', undefined)).toBe(true);
    expect(matchesPhaseFilter('intake', '')).toBe(true);
    expect(matchesPhaseFilter('intake', [])).toBe(true);
  });

  it('matches single-string filter exactly', () => {
    expect(matchesPhaseFilter('intake', 'intake')).toBe(true);
    expect(matchesPhaseFilter('interview', 'intake')).toBe(false);
  });

  it('matches array filter by membership', () => {
    expect(
      matchesPhaseFilter('orientation', ['onboarding', 'orientation']),
    ).toBe(true);
    expect(
      matchesPhaseFilter('intake', ['onboarding', 'orientation']),
    ).toBe(false);
  });
});

describe('filterActiveCaregiversForCheckIn', () => {
  const base = { archived: false };
  const caregivers = [
    { id: 'a', ...base, phase: 'orientation' },
    { id: 'b', ...base, phase: 'onboarding' },
    { id: 'c', archived: true, phase: 'orientation' },
    { id: 'd', ...base, smsOptedOut: true, phase: 'orientation' },
    { id: 'e', ...base, availabilityCheckPaused: true, phase: 'orientation' },
    { id: 'f', ...base, phase: 'intake' },
  ];

  it('keeps only active caregivers when no phase filter is set', () => {
    const out = filterActiveCaregiversForCheckIn(caregivers);
    expect(out.map((c) => c.id).sort()).toEqual(['a', 'b', 'f']);
  });

  it('applies phase filter on top of active check', () => {
    const out = filterActiveCaregiversForCheckIn(caregivers, {
      phase: 'orientation',
    });
    expect(out.map((c) => c.id)).toEqual(['a']);
  });

  it('accepts array phase filter', () => {
    const out = filterActiveCaregiversForCheckIn(caregivers, {
      phase: ['orientation', 'onboarding'],
    });
    expect(out.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  it('tolerates snake_case phase_override from raw DB rows', () => {
    const rawRows = [
      { id: 'x', archived: false, phase_override: 'orientation' },
      { id: 'y', archived: false, phase_override: 'intake' },
    ];
    const out = filterActiveCaregiversForCheckIn(rawRows, {
      phase: 'orientation',
    });
    expect(out.map((c) => c.id)).toEqual(['x']);
  });

  it('returns [] for non-array input', () => {
    expect(filterActiveCaregiversForCheckIn(null)).toEqual([]);
    expect(filterActiveCaregiversForCheckIn(undefined)).toEqual([]);
  });
});

describe('isDueForAvailabilityCheck', () => {
  const now = new Date('2026-04-18T12:00:00Z');

  it('is due when never fired before', () => {
    expect(isDueForAvailabilityCheck(null, 14, now)).toBe(true);
    expect(isDueForAvailabilityCheck(undefined, 14, now)).toBe(true);
  });

  it('is NOT due when fired one hour ago', () => {
    const lastFired = new Date(now.getTime() - 60 * 60 * 1000);
    expect(isDueForAvailabilityCheck(lastFired, 14, now)).toBe(false);
  });

  it('is NOT due when fired slightly under the interval', () => {
    const slightlyUnder = new Date(
      now.getTime() - (14 * 24 * 60 * 60 * 1000 - 60 * 1000),
    );
    expect(isDueForAvailabilityCheck(slightlyUnder, 14, now)).toBe(false);
  });

  it('is due at exactly the interval boundary', () => {
    const exactlyAt = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    expect(isDueForAvailabilityCheck(exactlyAt, 14, now)).toBe(true);
  });

  it('is due when long overdue', () => {
    const longAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    expect(isDueForAvailabilityCheck(longAgo, 14, now)).toBe(true);
  });

  it('accepts ISO string input', () => {
    const iso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(isDueForAvailabilityCheck(iso, 14, now)).toBe(true);
  });

  it('treats an unparseable timestamp as "never fired"', () => {
    expect(isDueForAvailabilityCheck('not a date', 14, now)).toBe(true);
  });

  it('throws when intervalDays is invalid', () => {
    expect(() => isDueForAvailabilityCheck(null, 0, now)).toThrow();
    expect(() => isDueForAvailabilityCheck(null, -5, now)).toThrow();
    expect(() => isDueForAvailabilityCheck(null, NaN, now)).toThrow();
    expect(() => isDueForAvailabilityCheck(null, '14', now)).toThrow();
  });
});

describe('isValidAvailabilityTemplate', () => {
  it('accepts a template with an availability_schedule question', () => {
    expect(
      isValidAvailabilityTemplate({
        questions: [
          { id: 'q1', type: 'yes_no' },
          { id: 'q2', type: 'availability_schedule' },
        ],
      }),
    ).toBe(true);
  });

  it('rejects a template with no availability_schedule question', () => {
    expect(
      isValidAvailabilityTemplate({
        questions: [{ id: 'q1', type: 'free_text' }],
      }),
    ).toBe(false);
  });

  it('rejects empty or missing templates', () => {
    expect(isValidAvailabilityTemplate(null)).toBe(false);
    expect(isValidAvailabilityTemplate(undefined)).toBe(false);
    expect(isValidAvailabilityTemplate({})).toBe(false);
    expect(isValidAvailabilityTemplate({ questions: [] })).toBe(false);
    expect(isValidAvailabilityTemplate({ questions: null })).toBe(false);
  });
});

describe('isWithinSendWindow', () => {
  const at = (hour) => new Date(`2026-04-18T${String(hour).padStart(2, '0')}:30:00`);

  it('accepts times inside a standard 9–17 window', () => {
    expect(isWithinSendWindow(at(9), 9, 17)).toBe(true);
    expect(isWithinSendWindow(at(12), 9, 17)).toBe(true);
    expect(isWithinSendWindow(at(16), 9, 17)).toBe(true);
  });

  it('rejects times outside a standard 9–17 window', () => {
    expect(isWithinSendWindow(at(8), 9, 17)).toBe(false);
    expect(isWithinSendWindow(at(17), 9, 17)).toBe(false);
    expect(isWithinSendWindow(at(23), 9, 17)).toBe(false);
  });

  it('supports an overnight window (22–6)', () => {
    expect(isWithinSendWindow(at(23), 22, 6)).toBe(true);
    expect(isWithinSendWindow(at(2), 22, 6)).toBe(true);
    expect(isWithinSendWindow(at(10), 22, 6)).toBe(false);
  });

  it('returns false for a non-Date input', () => {
    expect(isWithinSendWindow('12:00', 9, 17)).toBe(false);
    expect(isWithinSendWindow(null, 9, 17)).toBe(false);
  });
});
