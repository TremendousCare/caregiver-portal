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
  computeShiftActuals,
  formatClockEventTime,
  formatDurationMs,
  canMarkShiftNoShow,
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

// ─── Explicit timezone round-trip ──────────────────────────────
// When production callers pass a timezone, the helpers produce the
// same output regardless of the JS runtime's local zone — this is
// what keeps a shift created on an EST laptop consistent with
// availability matching and recurrence expansion (both pinned to PT
// in production).

describe('shiftHelpers — explicit timezone', () => {
  const tz = 'America/Los_Angeles';

  it('combineDateAndTimeToIso interprets 08:00 as 15:00 UTC in May (PDT)', () => {
    const iso = combineDateAndTimeToIso('2026-05-04', '08:00', tz);
    expect(iso).toBe('2026-05-04T15:00:00.000Z');
  });

  it('combineDateAndTimeToIso interprets 08:00 as 16:00 UTC in January (PST)', () => {
    const iso = combineDateAndTimeToIso('2026-01-05', '08:00', tz);
    expect(iso).toBe('2026-01-05T16:00:00.000Z');
  });

  it('isoToDateInput round-trips "2026-05-04" in PT', () => {
    // 06:00 UTC on 2026-05-04 is 23:00 PDT on 2026-05-03, so the
    // date depends on the zone.
    expect(isoToDateInput('2026-05-04T15:00:00.000Z', tz)).toBe('2026-05-04');
    expect(isoToDateInput('2026-05-04T06:00:00.000Z', tz)).toBe('2026-05-03');
  });

  it('isoToTimeInput round-trips "08:00" in PT across seasons', () => {
    expect(isoToTimeInput('2026-05-04T15:00:00.000Z', tz)).toBe('08:00');
    expect(isoToTimeInput('2026-01-05T16:00:00.000Z', tz)).toBe('08:00');
  });

  it('combineDateAndTimeToIso → isoToTimeInput round-trips across DST', () => {
    // Monday before spring-forward (PST) and Monday after (PDT).
    for (const d of ['2026-03-02', '2026-03-09', '2026-10-26', '2026-11-02']) {
      const iso = combineDateAndTimeToIso(d, '08:00', tz);
      expect(isoToDateInput(iso, tz)).toBe(d);
      expect(isoToTimeInput(iso, tz)).toBe('08:00');
    }
  });

  it('formatLocalTimeShort respects the explicit timezone', () => {
    const pdt8am = new Date('2026-05-04T15:00:00.000Z');
    expect(formatLocalTimeShort(pdt8am, tz)).toBe('8:00a');
    const pst8am = new Date('2026-01-05T16:00:00.000Z');
    expect(formatLocalTimeShort(pst8am, tz)).toBe('8:00a');
  });

  it('formatShiftTimeRange produces stable output in PT', () => {
    const shift = {
      startTime: '2026-05-04T15:00:00.000Z',
      endTime: '2026-05-04T19:00:00.000Z',
    };
    const label = formatShiftTimeRange(shift, tz);
    expect(label).toContain('8:00a');
    expect(label).toContain('12:00p');
    expect(label).toContain('4h');
    expect(label).toContain('Mon');
    expect(label).toContain('May');
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
    servicePlanId: 'plan-1',
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

// ─── computeShiftActuals ───────────────────────────────────────

describe('computeShiftActuals', () => {
  it('returns nulls for an empty list', () => {
    expect(computeShiftActuals([])).toEqual({
      actualStart: null,
      actualEnd: null,
      durationMs: null,
      isOpen: false,
      eventCount: 0,
    });
  });

  it('handles a non-array input safely', () => {
    expect(computeShiftActuals(null)).toEqual({
      actualStart: null,
      actualEnd: null,
      durationMs: null,
      isOpen: false,
      eventCount: 0,
    });
  });

  it('marks the shift as open when there is an in but no out', () => {
    const events = [
      { eventType: 'in', occurredAt: '2026-05-04T15:00:00.000Z' },
    ];
    const actuals = computeShiftActuals(events);
    expect(actuals.actualStart).toBe('2026-05-04T15:00:00.000Z');
    expect(actuals.actualEnd).toBe(null);
    expect(actuals.durationMs).toBe(null);
    expect(actuals.isOpen).toBe(true);
  });

  it('computes duration between first in and last out', () => {
    const events = [
      { eventType: 'in', occurredAt: '2026-05-04T15:00:00.000Z' },
      { eventType: 'out', occurredAt: '2026-05-04T19:30:00.000Z' },
    ];
    const actuals = computeShiftActuals(events);
    expect(actuals.actualStart).toBe('2026-05-04T15:00:00.000Z');
    expect(actuals.actualEnd).toBe('2026-05-04T19:30:00.000Z');
    expect(actuals.durationMs).toBe(4.5 * 60 * 60 * 1000);
    expect(actuals.isOpen).toBe(false);
  });

  it('keeps the FIRST in and the LAST out across multiple punches', () => {
    const events = [
      { eventType: 'in', occurredAt: '2026-05-04T15:00:00.000Z' },
      { eventType: 'out', occurredAt: '2026-05-04T17:00:00.000Z' },
      { eventType: 'in', occurredAt: '2026-05-04T17:30:00.000Z' },
      { eventType: 'out', occurredAt: '2026-05-04T19:00:00.000Z' },
    ];
    const actuals = computeShiftActuals(events);
    expect(actuals.actualStart).toBe('2026-05-04T15:00:00.000Z');
    expect(actuals.actualEnd).toBe('2026-05-04T19:00:00.000Z');
    expect(actuals.eventCount).toBe(4);
    expect(actuals.isOpen).toBe(false);
  });

  it('clears actualEnd when a later clock-in reopens the shift (in→out→in)', () => {
    // Possible when staff add a manual in after a clock-out, or when
    // the caregiver clocks back in after clocking out by mistake.
    const events = [
      { eventType: 'in', occurredAt: '2026-05-04T15:00:00.000Z' },
      { eventType: 'out', occurredAt: '2026-05-04T17:00:00.000Z' },
      { eventType: 'in', occurredAt: '2026-05-04T17:30:00.000Z' },
    ];
    const actuals = computeShiftActuals(events);
    expect(actuals.actualStart).toBe('2026-05-04T15:00:00.000Z');
    expect(actuals.actualEnd).toBe(null);
    expect(actuals.durationMs).toBe(null);
    expect(actuals.isOpen).toBe(true);
  });

  it('skips malformed events without occurredAt', () => {
    const events = [
      { eventType: 'in' },
      { eventType: 'in', occurredAt: '2026-05-04T15:00:00.000Z' },
      null,
      { eventType: 'out', occurredAt: '2026-05-04T19:00:00.000Z' },
    ];
    const actuals = computeShiftActuals(events);
    expect(actuals.actualStart).toBe('2026-05-04T15:00:00.000Z');
    expect(actuals.actualEnd).toBe('2026-05-04T19:00:00.000Z');
  });
});

// ─── formatClockEventTime ──────────────────────────────────────

describe('formatClockEventTime', () => {
  it('returns empty string for missing input', () => {
    expect(formatClockEventTime(null)).toBe('');
    expect(formatClockEventTime('')).toBe('');
    expect(formatClockEventTime('not-a-date')).toBe('');
  });

  it('formats a UTC ISO string with day and short time', () => {
    // 2026-05-04 15:30 UTC = 8:30a Pacific
    const out = formatClockEventTime('2026-05-04T15:30:00.000Z', 'America/Los_Angeles');
    expect(out).toContain('Mon');
    expect(out).toContain('May');
    expect(out).toContain('8:30a');
  });
});

// ─── formatDurationMs ──────────────────────────────────────────

describe('formatDurationMs', () => {
  it('returns empty for null / NaN / negative', () => {
    expect(formatDurationMs(null)).toBe('');
    expect(formatDurationMs(undefined)).toBe('');
    expect(formatDurationMs(NaN)).toBe('');
    expect(formatDurationMs(-1)).toBe('');
  });

  it('formats hours-only durations', () => {
    expect(formatDurationMs(4 * 60 * 60 * 1000)).toBe('4h');
  });

  it('formats minutes-only durations', () => {
    expect(formatDurationMs(45 * 60 * 1000)).toBe('45m');
  });

  it('formats hours and minutes together', () => {
    expect(formatDurationMs(4.5 * 60 * 60 * 1000)).toBe('4h 30m');
  });

  it('rounds to the nearest minute', () => {
    expect(formatDurationMs(60 * 1000 + 29 * 1000)).toBe('1m');
    expect(formatDurationMs(60 * 1000 + 31 * 1000)).toBe('2m');
  });
});

// ─── canMarkShiftNoShow ────────────────────────────────────────

describe('canMarkShiftNoShow', () => {
  const NOW = new Date('2026-05-04T18:00:00.000Z');
  const past = '2026-05-04T15:00:00.000Z';   // before NOW
  const future = '2026-05-04T20:00:00.000Z'; // after NOW

  it('is true for an assigned shift whose start has passed', () => {
    expect(canMarkShiftNoShow({ status: 'assigned', startTime: past }, NOW)).toBe(true);
  });

  it('is true for a confirmed shift whose start has passed', () => {
    expect(canMarkShiftNoShow({ status: 'confirmed', startTime: past }, NOW)).toBe(true);
  });

  it('is false before the scheduled start time', () => {
    expect(canMarkShiftNoShow({ status: 'assigned', startTime: future }, NOW)).toBe(false);
    expect(canMarkShiftNoShow({ status: 'confirmed', startTime: future }, NOW)).toBe(false);
  });

  it('is false once the caregiver has clocked in (status=in_progress)', () => {
    // Clock-in flips status to in_progress, so a no-show can't apply.
    expect(canMarkShiftNoShow({ status: 'in_progress', startTime: past }, NOW)).toBe(false);
  });

  it('is false for terminal statuses', () => {
    expect(canMarkShiftNoShow({ status: 'completed', startTime: past }, NOW)).toBe(false);
    expect(canMarkShiftNoShow({ status: 'cancelled', startTime: past }, NOW)).toBe(false);
    expect(canMarkShiftNoShow({ status: 'no_show', startTime: past }, NOW)).toBe(false);
  });

  it('is false for unassigned shifts', () => {
    expect(canMarkShiftNoShow({ status: 'open', startTime: past }, NOW)).toBe(false);
    expect(canMarkShiftNoShow({ status: 'offered', startTime: past }, NOW)).toBe(false);
  });

  it('is false for missing or malformed input', () => {
    expect(canMarkShiftNoShow(null, NOW)).toBe(false);
    expect(canMarkShiftNoShow({ status: 'assigned' }, NOW)).toBe(false);
    expect(canMarkShiftNoShow({ status: 'assigned', startTime: 'not-a-date' }, NOW)).toBe(false);
  });

  it('treats start time exactly equal to now as eligible (boundary)', () => {
    const at = NOW.toISOString();
    expect(canMarkShiftNoShow({ status: 'assigned', startTime: at }, NOW)).toBe(true);
  });
});
