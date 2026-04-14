import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SHIFT_DURATION_HOURS,
  SHIFT_STATUSES,
  SHIFT_CANCEL_REASONS,
  shiftStatusLabel,
  shiftStatusColors,
  computeDefaultShiftEnd,
  isoToTimeInput,
  isoToDateInput,
  combineDateAndTimeToIso,
  formatShiftTimeRange,
  formatLocalTimeShort,
  parseSkillsInput,
  formatSkillsInput,
  shiftToCalendarEvent,
  validateShiftDraft,
  buildShiftUpdatePatch,
} from '../../features/scheduling/shiftHelpers';

// ─── Constants ─────────────────────────────────────────────────

describe('constants', () => {
  it('has a 4-hour default shift duration (matches user decision)', () => {
    expect(DEFAULT_SHIFT_DURATION_HOURS).toBe(4);
  });

  it('lists all expected shift statuses', () => {
    expect(SHIFT_STATUSES).toEqual([
      'open',
      'offered',
      'assigned',
      'confirmed',
      'in_progress',
      'completed',
      'cancelled',
      'no_show',
    ]);
  });

  it('lists all expected cancel reasons', () => {
    expect(SHIFT_CANCEL_REASONS).toEqual([
      'Client cancelled',
      'Caregiver cancelled',
      'Agency cancelled',
      'Weather',
      'Other',
    ]);
  });
});

// ─── shiftStatusLabel ──────────────────────────────────────────

describe('shiftStatusLabel', () => {
  it('produces friendly labels for all valid statuses', () => {
    expect(shiftStatusLabel('open')).toBe('Open');
    expect(shiftStatusLabel('offered')).toBe('Offered');
    expect(shiftStatusLabel('assigned')).toBe('Assigned');
    expect(shiftStatusLabel('confirmed')).toBe('Confirmed');
    expect(shiftStatusLabel('in_progress')).toBe('In progress');
    expect(shiftStatusLabel('completed')).toBe('Completed');
    expect(shiftStatusLabel('cancelled')).toBe('Cancelled');
    expect(shiftStatusLabel('no_show')).toBe('No-show');
  });

  it('falls back to raw value for unknown statuses', () => {
    expect(shiftStatusLabel('foo')).toBe('foo');
  });

  it('returns "Unknown" for missing status', () => {
    expect(shiftStatusLabel(null)).toBe('Unknown');
    expect(shiftStatusLabel(undefined)).toBe('Unknown');
  });
});

// ─── shiftStatusColors ─────────────────────────────────────────

describe('shiftStatusColors', () => {
  it('returns a color scheme for each valid status', () => {
    for (const s of SHIFT_STATUSES) {
      const c = shiftStatusColors(s);
      expect(c.bg).toBeTruthy();
      expect(c.fg).toBeTruthy();
      expect(c.border).toBeTruthy();
    }
  });

  it('returns a default scheme for unknown statuses', () => {
    const c = shiftStatusColors('bogus');
    expect(c.bg).toBeTruthy();
  });

  it('open status uses red tones', () => {
    expect(shiftStatusColors('open').border).toMatch(/F87171/i);
  });

  it('confirmed status uses green tones', () => {
    expect(shiftStatusColors('confirmed').border).toMatch(/4ADE80/i);
  });
});

// ─── computeDefaultShiftEnd ────────────────────────────────────

describe('computeDefaultShiftEnd', () => {
  it('adds the default 4 hours to a start time', () => {
    const start = new Date('2026-05-04T08:00:00.000Z');
    const end = computeDefaultShiftEnd(start);
    expect(end.toISOString()).toBe('2026-05-04T12:00:00.000Z');
  });

  it('accepts an ISO string as start', () => {
    const end = computeDefaultShiftEnd('2026-05-04T08:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-04T12:00:00.000Z');
  });

  it('accepts a custom duration', () => {
    const end = computeDefaultShiftEnd('2026-05-04T08:00:00.000Z', 8);
    expect(end.toISOString()).toBe('2026-05-04T16:00:00.000Z');
  });

  it('does not mutate the input Date', () => {
    const start = new Date('2026-05-04T08:00:00.000Z');
    const originalMs = start.getTime();
    computeDefaultShiftEnd(start);
    expect(start.getTime()).toBe(originalMs);
  });
});

// ─── Date/time input helpers ───────────────────────────────────

describe('isoToTimeInput / isoToDateInput', () => {
  it('returns empty string for missing input', () => {
    expect(isoToTimeInput(null)).toBe('');
    expect(isoToDateInput(null)).toBe('');
    expect(isoToTimeInput('')).toBe('');
  });

  it('returns empty string for invalid input', () => {
    expect(isoToTimeInput('not a date')).toBe('');
    expect(isoToDateInput('not a date')).toBe('');
  });

  it('formats valid ISO strings', () => {
    // Both results depend on the local timezone of the test environment,
    // so we can't assert exact values. We just check length and format.
    const time = isoToTimeInput('2026-05-04T08:00:00.000Z');
    expect(time).toMatch(/^\d{2}:\d{2}$/);
    const date = isoToDateInput('2026-05-04T08:00:00.000Z');
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('combineDateAndTimeToIso', () => {
  it('returns null for missing input', () => {
    expect(combineDateAndTimeToIso('', '08:00')).toBeNull();
    expect(combineDateAndTimeToIso('2026-05-04', '')).toBeNull();
    expect(combineDateAndTimeToIso(null, null)).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(combineDateAndTimeToIso('not-a-date', '08:00')).toBeNull();
  });

  it('returns a valid ISO string for valid inputs', () => {
    const iso = combineDateAndTimeToIso('2026-05-04', '08:00');
    expect(typeof iso).toBe('string');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('round-trip preserves date+time', () => {
    const iso = combineDateAndTimeToIso('2026-05-04', '14:30');
    expect(iso).toBeTruthy();
    expect(isoToDateInput(iso)).toBe('2026-05-04');
    expect(isoToTimeInput(iso)).toBe('14:30');
  });
});

// ─── formatShiftTimeRange / formatLocalTimeShort ───────────────

describe('formatShiftTimeRange', () => {
  it('returns empty string for missing shift', () => {
    expect(formatShiftTimeRange(null)).toBe('');
    expect(formatShiftTimeRange({})).toBe('');
  });

  it('includes day label and duration', () => {
    const shift = {
      startTime: '2026-05-04T08:00:00.000Z',
      endTime: '2026-05-04T12:00:00.000Z',
    };
    const label = formatShiftTimeRange(shift);
    expect(label).toContain('(4h)');
    // Day label depends on local TZ but should contain a 3-letter weekday
    expect(label).toMatch(/[A-Z][a-z]{2}/);
  });

  it('formats sub-hour durations in minutes', () => {
    const shift = {
      startTime: '2026-05-04T08:00:00.000Z',
      endTime: '2026-05-04T08:30:00.000Z',
    };
    expect(formatShiftTimeRange(shift)).toContain('30m');
  });

  it('formats fractional hours', () => {
    const shift = {
      startTime: '2026-05-04T08:00:00.000Z',
      endTime: '2026-05-04T09:30:00.000Z',
    };
    expect(formatShiftTimeRange(shift)).toContain('1.5h');
  });
});

describe('formatLocalTimeShort', () => {
  it('returns empty string for invalid input', () => {
    expect(formatLocalTimeShort(null)).toBe('');
    expect(formatLocalTimeShort(new Date('invalid'))).toBe('');
  });

  it('formats a date with 12-hour clock', () => {
    // Pick a time that's unambiguous across timezones:
    // We'll build a local-time Date to avoid TZ issues.
    const d = new Date(2026, 4, 4, 8, 0, 0, 0); // May 4 2026 08:00 local
    expect(formatLocalTimeShort(d)).toBe('8:00a');
  });

  it('formats noon as 12:00p', () => {
    const d = new Date(2026, 4, 4, 12, 0, 0, 0);
    expect(formatLocalTimeShort(d)).toBe('12:00p');
  });

  it('formats midnight as 12:00a', () => {
    const d = new Date(2026, 4, 4, 0, 0, 0, 0);
    expect(formatLocalTimeShort(d)).toBe('12:00a');
  });

  it('formats PM minutes', () => {
    const d = new Date(2026, 4, 4, 14, 30, 0, 0);
    expect(formatLocalTimeShort(d)).toBe('2:30p');
  });
});

// ─── parseSkillsInput / formatSkillsInput ──────────────────────

describe('parseSkillsInput', () => {
  it('returns an empty array for falsy input', () => {
    expect(parseSkillsInput('')).toEqual([]);
    expect(parseSkillsInput(null)).toEqual([]);
    expect(parseSkillsInput(undefined)).toEqual([]);
  });

  it('splits on commas and trims whitespace', () => {
    expect(parseSkillsInput('Hoyer lift, dementia care, transfer')).toEqual([
      'Hoyer lift',
      'dementia care',
      'transfer',
    ]);
  });

  it('filters empty tokens', () => {
    expect(parseSkillsInput('a,, b , ,c')).toEqual(['a', 'b', 'c']);
  });

  it('preserves original casing', () => {
    expect(parseSkillsInput('HOYER, Dementia')).toEqual(['HOYER', 'Dementia']);
  });
});

describe('formatSkillsInput', () => {
  it('returns empty string for non-array', () => {
    expect(formatSkillsInput(null)).toBe('');
    expect(formatSkillsInput('nope')).toBe('');
  });

  it('joins array with comma+space', () => {
    expect(formatSkillsInput(['Hoyer lift', 'dementia care'])).toBe('Hoyer lift, dementia care');
  });

  it('round-trips with parseSkillsInput', () => {
    const skills = ['Hoyer lift', 'dementia care', 'transfer'];
    expect(parseSkillsInput(formatSkillsInput(skills))).toEqual(skills);
  });
});

// ─── shiftToCalendarEvent ──────────────────────────────────────

describe('shiftToCalendarEvent', () => {
  const clientsById = {
    c1: { id: 'c1', firstName: 'Alice', lastName: 'Johnson' },
  };
  const caregiversById = {
    cg1: { id: 'cg1', firstName: 'Maria', lastName: 'Garcia' },
  };
  const baseShift = {
    id: 'shift-1',
    clientId: 'c1',
    assignedCaregiverId: null,
    startTime: '2026-05-04T08:00:00.000Z',
    endTime: '2026-05-04T12:00:00.000Z',
    status: 'open',
  };

  it('returns null for missing shift', () => {
    expect(shiftToCalendarEvent(null)).toBeNull();
  });

  it('returns null when start/end are missing', () => {
    expect(shiftToCalendarEvent({ id: 'x' })).toBeNull();
  });

  it('builds an event with id, start, end, and colors', () => {
    const event = shiftToCalendarEvent(baseShift, { clientsById, caregiversById });
    expect(event.id).toBe('shift-1');
    expect(event.start).toBe('2026-05-04T08:00:00.000Z');
    expect(event.end).toBe('2026-05-04T12:00:00.000Z');
    expect(event.backgroundColor).toBeTruthy();
    expect(event.borderColor).toBeTruthy();
  });

  it('title includes client name and "(open)" when unassigned', () => {
    const event = shiftToCalendarEvent(baseShift, { clientsById, caregiversById });
    expect(event.title).toContain('Alice Johnson');
    expect(event.title).toContain('(open)');
  });

  it('title includes caregiver name when assigned', () => {
    const event = shiftToCalendarEvent(
      { ...baseShift, assignedCaregiverId: 'cg1' },
      { clientsById, caregiversById },
    );
    expect(event.title).toContain('Alice Johnson');
    expect(event.title).toContain('Maria Garcia');
    expect(event.title).not.toContain('(open)');
  });

  it('stashes the full shift on extendedProps', () => {
    const event = shiftToCalendarEvent(baseShift, { clientsById, caregiversById });
    expect(event.extendedProps.shift).toEqual(baseShift);
  });

  it('handles missing clientsById / caregiversById gracefully', () => {
    const event = shiftToCalendarEvent(baseShift);
    expect(event.title).toContain('Client');
  });
});

// ─── validateShiftDraft ────────────────────────────────────────

describe('validateShiftDraft', () => {
  const base = {
    clientId: 'c1',
    startTime: '2026-05-04T08:00:00.000Z',
    endTime: '2026-05-04T12:00:00.000Z',
  };

  it('accepts a valid minimal draft', () => {
    expect(validateShiftDraft(base)).toBeNull();
  });

  it('rejects missing clientId', () => {
    expect(validateShiftDraft({ ...base, clientId: '' })).toMatch(/client/i);
  });

  it('rejects missing start time', () => {
    expect(validateShiftDraft({ ...base, startTime: '' })).toMatch(/start/i);
  });

  it('rejects missing end time', () => {
    expect(validateShiftDraft({ ...base, endTime: '' })).toMatch(/end/i);
  });

  it('rejects end time before start time', () => {
    expect(
      validateShiftDraft({
        ...base,
        startTime: '2026-05-04T12:00:00.000Z',
        endTime: '2026-05-04T08:00:00.000Z',
      }),
    ).toMatch(/after/i);
  });

  it('rejects end time equal to start time', () => {
    expect(
      validateShiftDraft({
        ...base,
        endTime: base.startTime,
      }),
    ).toMatch(/after/i);
  });

  it('rejects negative rate', () => {
    expect(validateShiftDraft({ ...base, hourlyRate: -5 })).toMatch(/hourly/i);
  });

  it('accepts zero rates', () => {
    expect(validateShiftDraft({ ...base, hourlyRate: 0, billableRate: 0 })).toBeNull();
  });

  it('accepts empty string rate fields (meaning "not set")', () => {
    expect(
      validateShiftDraft({ ...base, hourlyRate: '', billableRate: '', mileage: '' }),
    ).toBeNull();
  });

  it('rejects non-numeric rate values', () => {
    expect(validateShiftDraft({ ...base, hourlyRate: 'lots' })).toMatch(/hourly/i);
  });
});

// ─── buildShiftUpdatePatch ─────────────────────────────────────

describe('buildShiftUpdatePatch', () => {
  const original = {
    clientId: 'c1',
    carePlanId: 'plan-1',
    startTime: '2026-05-04T08:00:00.000Z',
    endTime: '2026-05-04T12:00:00.000Z',
    status: 'assigned',
    assignedCaregiverId: 'cg1',
    hourlyRate: 25,
    billableRate: 40,
    mileage: null,
    requiredSkills: ['Hoyer lift'],
    instructions: 'Morning routine',
    notes: null,
    locationAddress: '123 Main St',
  };

  it('returns empty patch when nothing changed', () => {
    expect(buildShiftUpdatePatch(original, { ...original })).toEqual({});
  });

  it('returns only the changed field when one field changes', () => {
    const patch = buildShiftUpdatePatch(original, { ...original, status: 'confirmed' });
    expect(patch).toEqual({ status: 'confirmed' });
  });

  it('detects rate changes', () => {
    const patch = buildShiftUpdatePatch(original, { ...original, hourlyRate: 30 });
    expect(patch).toEqual({ hourlyRate: 30 });
  });

  it('detects changes to the required_skills array', () => {
    const patch = buildShiftUpdatePatch(original, {
      ...original,
      requiredSkills: ['Hoyer lift', 'dementia care'],
    });
    expect(patch).toEqual({ requiredSkills: ['Hoyer lift', 'dementia care'] });
  });

  it('does not report skill-array change when the array has the same contents', () => {
    const patch = buildShiftUpdatePatch(original, {
      ...original,
      requiredSkills: ['Hoyer lift'],
    });
    expect(patch).toEqual({});
  });

  it('treats null vs empty string as equivalent for notes', () => {
    const patch = buildShiftUpdatePatch({ ...original, notes: null }, { ...original, notes: null });
    expect(patch).toEqual({});
  });

  it('detects multiple simultaneous changes', () => {
    const patch = buildShiftUpdatePatch(original, {
      ...original,
      status: 'confirmed',
      notes: 'Updated note',
    });
    expect(patch).toEqual({
      status: 'confirmed',
      notes: 'Updated note',
    });
  });
});
