import { describe, it, expect } from 'vitest';
import {
  DAY_OF_WEEK_LABELS_SHORT,
  GENERATE_WEEKS_OPTIONS,
  GENERATE_WEEKS_DEFAULT,
  emptyRecurrencePattern,
  hasRecurrencePattern,
  validateRecurrencePattern,
  formatClockLabel,
  describeRecurrencePattern,
  toggleDayInPattern,
  filterOutExistingInstances,
} from '../../features/scheduling/recurrenceHelpers';

// ─── Constants ─────────────────────────────────────────────────

describe('constants', () => {
  it('has 7 day-of-week labels', () => {
    expect(DAY_OF_WEEK_LABELS_SHORT).toHaveLength(7);
    expect(DAY_OF_WEEK_LABELS_SHORT[0]).toBe('Sun');
    expect(DAY_OF_WEEK_LABELS_SHORT[6]).toBe('Sat');
  });

  it('has a default generate-weeks value in the options list', () => {
    expect(GENERATE_WEEKS_OPTIONS).toContain(GENERATE_WEEKS_DEFAULT);
  });

  it('default generate-weeks is 4 per user decision', () => {
    expect(GENERATE_WEEKS_DEFAULT).toBe(4);
  });
});

// ─── emptyRecurrencePattern ───────────────────────────────────

describe('emptyRecurrencePattern', () => {
  it('creates a valid empty pattern', () => {
    const p = emptyRecurrencePattern();
    expect(p.frequency).toBe('weekly');
    expect(p.days_of_week).toEqual([]);
    expect(p.start_time).toBe('08:00');
    expect(p.end_time).toBe('12:00');
    expect(p.exceptions).toEqual([]);
  });
});

// ─── hasRecurrencePattern ─────────────────────────────────────

describe('hasRecurrencePattern', () => {
  it('returns false for null / undefined / non-object', () => {
    expect(hasRecurrencePattern(null)).toBe(false);
    expect(hasRecurrencePattern(undefined)).toBe(false);
    expect(hasRecurrencePattern('nope')).toBe(false);
  });

  it('returns false for empty days_of_week', () => {
    expect(
      hasRecurrencePattern({
        frequency: 'weekly',
        days_of_week: [],
        start_time: '08:00',
        end_time: '12:00',
      }),
    ).toBe(false);
  });

  it('returns false for non-weekly frequency', () => {
    expect(
      hasRecurrencePattern({
        frequency: 'monthly',
        days_of_week: [1],
        start_time: '08:00',
        end_time: '12:00',
      }),
    ).toBe(false);
  });

  it('returns false for missing times', () => {
    expect(
      hasRecurrencePattern({
        frequency: 'weekly',
        days_of_week: [1],
        start_time: '',
        end_time: '12:00',
      }),
    ).toBe(false);
  });

  it('returns true for a complete pattern', () => {
    expect(
      hasRecurrencePattern({
        frequency: 'weekly',
        days_of_week: [1, 3, 5],
        start_time: '08:00',
        end_time: '12:00',
      }),
    ).toBe(true);
  });
});

// ─── validateRecurrencePattern ────────────────────────────────

describe('validateRecurrencePattern', () => {
  const valid = {
    frequency: 'weekly',
    days_of_week: [1, 3, 5],
    start_time: '08:00',
    end_time: '12:00',
    start_date: '2026-05-01',
    end_date: '2026-12-31',
  };

  it('accepts a valid pattern', () => {
    expect(validateRecurrencePattern(valid)).toBeNull();
  });

  it('rejects null', () => {
    expect(validateRecurrencePattern(null)).toBeTruthy();
  });

  it('rejects empty days_of_week', () => {
    expect(validateRecurrencePattern({ ...valid, days_of_week: [] })).toMatch(/day/i);
  });

  it('rejects invalid day index', () => {
    expect(validateRecurrencePattern({ ...valid, days_of_week: [7] })).toMatch(/invalid/i);
  });

  it('rejects missing start_time', () => {
    expect(validateRecurrencePattern({ ...valid, start_time: '' })).toMatch(/time/i);
  });

  it('rejects end before start', () => {
    expect(
      validateRecurrencePattern({ ...valid, start_time: '12:00', end_time: '08:00' }),
    ).toMatch(/after/i);
  });

  it('rejects equal start and end', () => {
    expect(
      validateRecurrencePattern({ ...valid, start_time: '10:00', end_time: '10:00' }),
    ).toMatch(/after/i);
  });

  it('rejects invalid clock format', () => {
    expect(validateRecurrencePattern({ ...valid, start_time: 'nope' })).toMatch(/format/i);
  });

  it('rejects end_date before start_date', () => {
    expect(
      validateRecurrencePattern({
        ...valid,
        start_date: '2026-06-01',
        end_date: '2026-05-01',
      }),
    ).toMatch(/end date/i);
  });

  it('accepts a pattern with only one day', () => {
    expect(
      validateRecurrencePattern({ ...valid, days_of_week: [3] }),
    ).toBeNull();
  });

  it('accepts a pattern with no dates', () => {
    expect(
      validateRecurrencePattern({ ...valid, start_date: null, end_date: null }),
    ).toBeNull();
  });
});

// ─── formatClockLabel ─────────────────────────────────────────

describe('formatClockLabel', () => {
  it('formats AM times', () => {
    expect(formatClockLabel('08:00')).toBe('8:00a');
    expect(formatClockLabel('00:30')).toBe('12:30a');
  });

  it('formats PM times', () => {
    expect(formatClockLabel('13:30')).toBe('1:30p');
    expect(formatClockLabel('23:00')).toBe('11:00p');
  });

  it('formats noon as 12:00p', () => {
    expect(formatClockLabel('12:00')).toBe('12:00p');
  });

  it('returns empty string for bad input', () => {
    expect(formatClockLabel('bogus')).toBe('');
    expect(formatClockLabel(null)).toBe('');
  });
});

// ─── describeRecurrencePattern ────────────────────────────────

describe('describeRecurrencePattern', () => {
  it('says "No recurrence set" for an invalid pattern', () => {
    expect(describeRecurrencePattern(null)).toBe('No recurrence set');
    expect(describeRecurrencePattern({ frequency: 'weekly', days_of_week: [] })).toBe('No recurrence set');
  });

  it('recognizes weekday shorthand (Mon-Fri)', () => {
    const desc = describeRecurrencePattern({
      frequency: 'weekly',
      days_of_week: [1, 2, 3, 4, 5],
      start_time: '08:00',
      end_time: '16:00',
    });
    expect(desc).toContain('Every weekday');
    expect(desc).toContain('8:00a');
    expect(desc).toContain('4:00p');
  });

  it('recognizes weekend shorthand (Sat + Sun)', () => {
    const desc = describeRecurrencePattern({
      frequency: 'weekly',
      days_of_week: [0, 6],
      start_time: '09:00',
      end_time: '17:00',
    });
    expect(desc).toContain('Every weekend');
  });

  it('recognizes every-day shorthand', () => {
    const desc = describeRecurrencePattern({
      frequency: 'weekly',
      days_of_week: [0, 1, 2, 3, 4, 5, 6],
      start_time: '06:00',
      end_time: '22:00',
    });
    expect(desc).toContain('Every day');
  });

  it('lists specific days otherwise', () => {
    const desc = describeRecurrencePattern({
      frequency: 'weekly',
      days_of_week: [1, 3, 5],
      start_time: '08:00',
      end_time: '12:00',
    });
    expect(desc).toContain('Mon');
    expect(desc).toContain('Wed');
    expect(desc).toContain('Fri');
  });

  it('sorts days chronologically in the summary', () => {
    const desc = describeRecurrencePattern({
      frequency: 'weekly',
      days_of_week: [5, 1, 3],
      start_time: '08:00',
      end_time: '12:00',
    });
    // Should read "Mon, Wed, Fri" even though input was shuffled
    const monIdx = desc.indexOf('Mon');
    const wedIdx = desc.indexOf('Wed');
    const friIdx = desc.indexOf('Fri');
    expect(monIdx).toBeLessThan(wedIdx);
    expect(wedIdx).toBeLessThan(friIdx);
  });
});

// ─── toggleDayInPattern ───────────────────────────────────────

describe('toggleDayInPattern', () => {
  it('adds a day when not present', () => {
    expect(toggleDayInPattern([], 1)).toEqual([1]);
    expect(toggleDayInPattern([1, 3], 5)).toEqual([1, 3, 5]);
  });

  it('removes a day when present', () => {
    expect(toggleDayInPattern([1, 3, 5], 3)).toEqual([1, 5]);
  });

  it('returns a sorted array', () => {
    expect(toggleDayInPattern([5, 1, 3], 2)).toEqual([1, 2, 3, 5]);
  });

  it('handles null / undefined input', () => {
    expect(toggleDayInPattern(null, 1)).toEqual([1]);
    expect(toggleDayInPattern(undefined, 1)).toEqual([1]);
  });
});

// ─── filterOutExistingInstances ───────────────────────────────

describe('filterOutExistingInstances', () => {
  const instances = [
    { start_time: '2026-05-04T08:00:00.000Z', end_time: '2026-05-04T12:00:00.000Z' },
    { start_time: '2026-05-06T08:00:00.000Z', end_time: '2026-05-06T12:00:00.000Z' },
    { start_time: '2026-05-08T08:00:00.000Z', end_time: '2026-05-08T12:00:00.000Z' },
  ];

  it('returns all instances when no existing shifts', () => {
    expect(filterOutExistingInstances(instances, [])).toHaveLength(3);
    expect(filterOutExistingInstances(instances, null)).toHaveLength(3);
  });

  it('filters out instances that match an existing shift start time', () => {
    const existing = [
      { startTime: '2026-05-06T08:00:00.000Z', endTime: '2026-05-06T12:00:00.000Z' },
    ];
    const result = filterOutExistingInstances(instances, existing);
    expect(result).toHaveLength(2);
    expect(result[0].start_time).toBe('2026-05-04T08:00:00.000Z');
    expect(result[1].start_time).toBe('2026-05-08T08:00:00.000Z');
  });

  it('returns empty when all instances already exist', () => {
    const existing = instances.map((i) => ({
      startTime: i.start_time,
      endTime: i.end_time,
    }));
    expect(filterOutExistingInstances(instances, existing)).toEqual([]);
  });

  it('handles empty instances input', () => {
    expect(filterOutExistingInstances([], [])).toEqual([]);
    expect(filterOutExistingInstances(null, null)).toEqual([]);
  });
});
