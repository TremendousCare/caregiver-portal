import { describe, it, expect } from 'vitest';
import {
  buildRecurringAvailabilityEvents,
  buildOneOffBackgroundEvents,
  weekBoundsContainingLocal,
  sumShiftHoursInWindow,
  countShiftsByStatus,
  sumActivePlanHours,
  formatScheduledVsPlanned,
} from '../../features/scheduling/scheduleViewHelpers';

// Reference: 2026-05-04 is a Monday, 2026-05-03 is Sunday
const WEEK_START = new Date(2026, 4, 3, 0, 0, 0, 0); // Sun May 3 2026
const WEEK_END = new Date(2026, 4, 9, 23, 59, 59, 999); // Sat May 9 2026

function localIso(y, mo, d, h = 0, mi = 0) {
  return new Date(y, mo - 1, d, h, mi, 0, 0).toISOString();
}

// ─── weekBoundsContainingLocal ────────────────────────────────

describe('weekBoundsContainingLocal', () => {
  it('returns Sunday-Saturday bounds for a Monday', () => {
    const bounds = weekBoundsContainingLocal(new Date(2026, 4, 4));
    expect(bounds.start.getDay()).toBe(0);
    expect(bounds.end.getDay()).toBe(6);
  });

  it('returns null for invalid input', () => {
    expect(weekBoundsContainingLocal('not a date')).toBeNull();
  });
});

// ─── buildRecurringAvailabilityEvents ─────────────────────────

describe('buildRecurringAvailabilityEvents', () => {
  it('returns empty array for empty input', () => {
    expect(buildRecurringAvailabilityEvents([], WEEK_START, WEEK_END)).toEqual([]);
    expect(buildRecurringAvailabilityEvents(null, WEEK_START, WEEK_END)).toEqual([]);
  });

  it('returns empty array when windowEnd is before windowStart', () => {
    expect(
      buildRecurringAvailabilityEvents(
        [{ id: '1', dayOfWeek: 1, startTime: '08:00', endTime: '12:00', type: 'available' }],
        WEEK_END,
        WEEK_START,
      ),
    ).toEqual([]);
  });

  it('generates one background event per matching day in window', () => {
    const rows = [
      { id: 'a1', dayOfWeek: 1, startTime: '08:00', endTime: '12:00', type: 'available' },
    ];
    // Window covers one full week (Sun-Sat) which contains exactly one Monday
    const events = buildRecurringAvailabilityEvents(rows, WEEK_START, WEEK_END);
    expect(events).toHaveLength(1);
    expect(events[0].display).toBe('background');
    expect(events[0].classNames).toContain('availability-bg');
    expect(events[0].classNames).toContain('availability-bg-available');
  });

  it('generates five events for a Mon-Fri availability', () => {
    const rows = [
      { id: 'mon', dayOfWeek: 1, startTime: '08:00', endTime: '16:00', type: 'available' },
      { id: 'tue', dayOfWeek: 2, startTime: '08:00', endTime: '16:00', type: 'available' },
      { id: 'wed', dayOfWeek: 3, startTime: '08:00', endTime: '16:00', type: 'available' },
      { id: 'thu', dayOfWeek: 4, startTime: '08:00', endTime: '16:00', type: 'available' },
      { id: 'fri', dayOfWeek: 5, startTime: '08:00', endTime: '16:00', type: 'available' },
    ];
    const events = buildRecurringAvailabilityEvents(rows, WEEK_START, WEEK_END);
    expect(events).toHaveLength(5);
  });

  it('marks unavailable rows with the unavailable class', () => {
    const rows = [
      { id: 'off', dayOfWeek: 1, startTime: '08:00', endTime: '16:00', type: 'unavailable' },
    ];
    const events = buildRecurringAvailabilityEvents(rows, WEEK_START, WEEK_END);
    expect(events).toHaveLength(1);
    expect(events[0].classNames).toContain('availability-bg-unavailable');
  });

  it('respects effective_from (skips rows not yet active)', () => {
    const rows = [
      {
        id: 'future',
        dayOfWeek: 1,
        startTime: '08:00',
        endTime: '16:00',
        type: 'available',
        effectiveFrom: '2026-06-01', // after the test week
      },
    ];
    expect(buildRecurringAvailabilityEvents(rows, WEEK_START, WEEK_END)).toEqual([]);
  });

  it('respects effective_until (skips rows already expired)', () => {
    const rows = [
      {
        id: 'past',
        dayOfWeek: 1,
        startTime: '08:00',
        endTime: '16:00',
        type: 'available',
        effectiveUntil: '2026-04-01', // before the test week
      },
    ];
    expect(buildRecurringAvailabilityEvents(rows, WEEK_START, WEEK_END)).toEqual([]);
  });

  it('skips rows with invalid or backwards clock times', () => {
    const rows = [
      { id: 'bad1', dayOfWeek: 1, startTime: 'bogus', endTime: '16:00', type: 'available' },
      { id: 'bad2', dayOfWeek: 1, startTime: '16:00', endTime: '08:00', type: 'available' },
    ];
    expect(buildRecurringAvailabilityEvents(rows, WEEK_START, WEEK_END)).toEqual([]);
  });

  it('skips one-off rows (handled by the other helper)', () => {
    const rows = [
      { id: 'vac', type: 'unavailable', startDate: '2026-05-04', endDate: '2026-05-08' },
    ];
    expect(buildRecurringAvailabilityEvents(rows, WEEK_START, WEEK_END)).toEqual([]);
  });
});

// ─── buildOneOffBackgroundEvents ──────────────────────────────

describe('buildOneOffBackgroundEvents', () => {
  it('returns empty for empty input', () => {
    expect(buildOneOffBackgroundEvents([], WEEK_START, WEEK_END)).toEqual([]);
    expect(buildOneOffBackgroundEvents(null, WEEK_START, WEEK_END)).toEqual([]);
  });

  it('generates an all-day background event for a date-only unavailability', () => {
    const rows = [
      { id: 'vac', type: 'unavailable', startDate: '2026-05-04', endDate: '2026-05-08' },
    ];
    const events = buildOneOffBackgroundEvents(rows, WEEK_START, WEEK_END);
    expect(events).toHaveLength(1);
    expect(events[0].display).toBe('background');
    expect(events[0].classNames).toContain('availability-bg-unavailable');
    // End is exclusive in FullCalendar, so should be 2026-05-09
    expect(events[0].end).toBe('2026-05-09');
    expect(events[0].start).toBe('2026-05-04');
  });

  it('skips rows entirely outside the window', () => {
    const rows = [
      { id: 'future', type: 'unavailable', startDate: '2026-07-01', endDate: '2026-07-10' },
    ];
    expect(buildOneOffBackgroundEvents(rows, WEEK_START, WEEK_END)).toEqual([]);
  });

  it('generates a timed background for same-day with hours', () => {
    const rows = [
      {
        id: 'appt',
        type: 'unavailable',
        startDate: '2026-05-04',
        endDate: '2026-05-04',
        startTime: '14:00',
        endTime: '15:00',
      },
    ];
    const events = buildOneOffBackgroundEvents(rows, WEEK_START, WEEK_END);
    expect(events).toHaveLength(1);
    expect(events[0].start).toBe('2026-05-04T14:00:00');
    expect(events[0].end).toBe('2026-05-04T15:00:00');
  });

  it('skips recurring rows (those are handled by the other helper)', () => {
    const rows = [
      { id: 'mon', dayOfWeek: 1, startTime: '08:00', endTime: '16:00', type: 'available' },
    ];
    expect(buildOneOffBackgroundEvents(rows, WEEK_START, WEEK_END)).toEqual([]);
  });
});

// ─── sumShiftHoursInWindow ────────────────────────────────────

describe('sumShiftHoursInWindow', () => {
  it('returns 0 for empty input', () => {
    expect(sumShiftHoursInWindow([], WEEK_START, WEEK_END)).toBe(0);
    expect(sumShiftHoursInWindow(null, WEEK_START, WEEK_END)).toBe(0);
  });

  it('counts confirmed and assigned shifts', () => {
    const shifts = [
      { startTime: localIso(2026, 5, 4, 8), endTime: localIso(2026, 5, 4, 12), status: 'confirmed' },
      { startTime: localIso(2026, 5, 5, 9), endTime: localIso(2026, 5, 5, 13), status: 'assigned' },
    ];
    expect(sumShiftHoursInWindow(shifts, WEEK_START, WEEK_END)).toBe(8);
  });

  it('ignores cancelled and no_show shifts', () => {
    const shifts = [
      { startTime: localIso(2026, 5, 4, 8), endTime: localIso(2026, 5, 4, 12), status: 'cancelled' },
      { startTime: localIso(2026, 5, 4, 13), endTime: localIso(2026, 5, 4, 17), status: 'no_show' },
    ];
    expect(sumShiftHoursInWindow(shifts, WEEK_START, WEEK_END)).toBe(0);
  });

  it('ignores open and offered shifts (not yet consuming the schedule)', () => {
    const shifts = [
      { startTime: localIso(2026, 5, 4, 8), endTime: localIso(2026, 5, 4, 12), status: 'open' },
      { startTime: localIso(2026, 5, 4, 13), endTime: localIso(2026, 5, 4, 17), status: 'offered' },
    ];
    expect(sumShiftHoursInWindow(shifts, WEEK_START, WEEK_END)).toBe(0);
  });
});

// ─── countShiftsByStatus ──────────────────────────────────────

describe('countShiftsByStatus', () => {
  it('counts by status bucket', () => {
    const shifts = [
      { status: 'confirmed' },
      { status: 'confirmed' },
      { status: 'assigned' },
      { status: 'completed' },
      { status: 'open' },
      { status: 'cancelled' },
    ];
    const counts = countShiftsByStatus(shifts);
    expect(counts.total).toBe(6);
    expect(counts.confirmed).toBe(2);
    expect(counts.assigned).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.open).toBe(1);
    expect(counts.cancelled).toBe(1);
  });

  it('returns zeros for empty input', () => {
    expect(countShiftsByStatus([]).total).toBe(0);
    expect(countShiftsByStatus(null).total).toBe(0);
  });
});

// ─── sumActivePlanHours ───────────────────────────────────────

describe('sumActivePlanHours', () => {
  it('sums only active plans', () => {
    const plans = [
      { status: 'active', hoursPerWeek: 20 },
      { status: 'draft', hoursPerWeek: 10 },
      { status: 'active', hoursPerWeek: 8 },
      { status: 'ended', hoursPerWeek: 40 },
    ];
    expect(sumActivePlanHours(plans)).toBe(28);
  });

  it('returns 0 for no active plans', () => {
    expect(sumActivePlanHours([{ status: 'draft', hoursPerWeek: 10 }])).toBe(0);
  });

  it('handles null / empty input', () => {
    expect(sumActivePlanHours(null)).toBe(0);
    expect(sumActivePlanHours([])).toBe(0);
  });

  it('ignores plans with missing or invalid hoursPerWeek', () => {
    const plans = [
      { status: 'active', hoursPerWeek: null },
      { status: 'active', hoursPerWeek: 20 },
      { status: 'active', hoursPerWeek: -5 },
    ];
    expect(sumActivePlanHours(plans)).toBe(20);
  });
});

// ─── formatScheduledVsPlanned ─────────────────────────────────

describe('formatScheduledVsPlanned', () => {
  it('returns bare hours when no plan target', () => {
    expect(formatScheduledVsPlanned(18, 0)).toBe('18 hrs scheduled');
    expect(formatScheduledVsPlanned(18, null)).toBe('18 hrs scheduled');
  });

  it('returns "X of Y" when under target', () => {
    expect(formatScheduledVsPlanned(18, 20)).toBe('18 of 20 hrs scheduled');
  });

  it('returns "meets plan" when at or over target', () => {
    expect(formatScheduledVsPlanned(20, 20)).toBe('20 hrs scheduled (meets plan)');
    expect(formatScheduledVsPlanned(25, 20)).toBe('25 hrs scheduled (meets plan)');
  });

  it('returns "unfilled" when zero scheduled but plan target set', () => {
    expect(formatScheduledVsPlanned(0, 20)).toBe('0 of 20 hrs scheduled (unfilled)');
  });

  it('rounds to 1 decimal', () => {
    expect(formatScheduledVsPlanned(18.456, 20)).toBe('18.5 of 20 hrs scheduled');
  });
});
