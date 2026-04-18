import { describe, it, expect } from 'vitest';
import {
  isActiveForAvailabilityCheckIn,
  matchesPhaseFilter,
  filterActiveCaregiversForCheckIn,
  isDueForAvailabilityCheck,
  isValidAvailabilityTemplate,
  isWithinSendWindow,
  resolveAvailabilityCheckInConditions,
  DEFAULT_INTERVAL_DAYS,
  DEFAULT_START_HOUR,
  DEFAULT_END_HOUR,
} from '../../../supabase/functions/_shared/helpers/availabilityCheckIn.ts';

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

  it('is NOT due when fired well under the interval', () => {
    // 10 minutes short of the 14-day mark — definitively under even with
    // the 2-minute cron-jitter tolerance built into the helper.
    const wellUnder = new Date(
      now.getTime() - (14 * 24 * 60 * 60 * 1000 - 10 * 60 * 1000),
    );
    expect(isDueForAvailabilityCheck(wellUnder, 14, now)).toBe(false);
  });

  it('is due at exactly the interval boundary (tolerance applied)', () => {
    const exactlyAt = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    expect(isDueForAvailabilityCheck(exactlyAt, 14, now)).toBe(true);
  });

  it('is due within the 2-minute tolerance window', () => {
    // 1 minute short of 14 days — within the cron-jitter tolerance, so
    // the rule fires instead of drifting to 14.5 days each cycle.
    const withinTolerance = new Date(
      now.getTime() - (14 * 24 * 60 * 60 * 1000 - 60 * 1000),
    );
    expect(isDueForAvailabilityCheck(withinTolerance, 14, now)).toBe(true);
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
  // Build a Date at a specific UTC hour. Tests use tz='UTC' so the local
  // hour the helper computes equals the UTC hour we supply.
  const atUtc = (hour) =>
    new Date(`2026-04-18T${String(hour).padStart(2, '0')}:30:00Z`);

  it('accepts times inside a standard 9–17 window', () => {
    expect(isWithinSendWindow(atUtc(9), 'UTC', 9, 17)).toBe(true);
    expect(isWithinSendWindow(atUtc(12), 'UTC', 9, 17)).toBe(true);
    expect(isWithinSendWindow(atUtc(16), 'UTC', 9, 17)).toBe(true);
  });

  it('rejects times outside a standard 9–17 window', () => {
    expect(isWithinSendWindow(atUtc(8), 'UTC', 9, 17)).toBe(false);
    expect(isWithinSendWindow(atUtc(17), 'UTC', 9, 17)).toBe(false);
    expect(isWithinSendWindow(atUtc(23), 'UTC', 9, 17)).toBe(false);
  });

  it('supports an overnight window (22–6)', () => {
    expect(isWithinSendWindow(atUtc(23), 'UTC', 22, 6)).toBe(true);
    expect(isWithinSendWindow(atUtc(2), 'UTC', 22, 6)).toBe(true);
    expect(isWithinSendWindow(atUtc(10), 'UTC', 22, 6)).toBe(false);
  });

  it('returns false for a non-Date input', () => {
    expect(isWithinSendWindow('12:00', 'UTC', 9, 17)).toBe(false);
    expect(isWithinSendWindow(null, 'UTC', 9, 17)).toBe(false);
  });

  it('falls back gracefully on an invalid timezone', () => {
    // Invalid tz should still compute a boolean, not throw.
    const result = isWithinSendWindow(atUtc(12), 'Not/AValidZone', 9, 17);
    expect(typeof result).toBe('boolean');
  });
});

describe('resolveAvailabilityCheckInConditions', () => {
  it('applies defaults for a null/empty conditions object', () => {
    const out = resolveAvailabilityCheckInConditions(null);
    expect(out.interval_days).toBe(DEFAULT_INTERVAL_DAYS);
    expect(out.start_hour).toBe(DEFAULT_START_HOUR);
    expect(out.end_hour).toBe(DEFAULT_END_HOUR);
    expect(out.phase).toBeNull();
    expect(out.survey_template_id).toBeNull();
  });

  it('honors valid explicit values', () => {
    const out = resolveAvailabilityCheckInConditions({
      interval_days: 7,
      start_hour: 10,
      end_hour: 18,
      survey_template_id: 'tpl-123',
      phase: ['orientation'],
    });
    expect(out.interval_days).toBe(7);
    expect(out.start_hour).toBe(10);
    expect(out.end_hour).toBe(18);
    expect(out.survey_template_id).toBe('tpl-123');
    expect(out.phase).toEqual(['orientation']);
  });

  it('rejects invalid interval_days and falls back to default', () => {
    expect(
      resolveAvailabilityCheckInConditions({ interval_days: 0 }).interval_days,
    ).toBe(DEFAULT_INTERVAL_DAYS);
    expect(
      resolveAvailabilityCheckInConditions({ interval_days: -1 }).interval_days,
    ).toBe(DEFAULT_INTERVAL_DAYS);
    expect(
      resolveAvailabilityCheckInConditions({ interval_days: '14' })
        .interval_days,
    ).toBe(DEFAULT_INTERVAL_DAYS);
  });
});
