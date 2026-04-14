import { describe, it, expect } from 'vitest';
import {
  rankCaregiversForShift,
  splitRankedList,
  formatEligibleReason,
  weekBoundsContaining,
  sumHoursInWindow,
  roleTierLabel,
  ROLE_TIER_PRIMARY,
  ROLE_TIER_BACKUP,
  ROLE_TIER_FLOAT,
  ROLE_TIER_NONE,
} from '../../features/scheduling/eligibilityRanking';

// ─── Test helpers ─────────────────────────────────────────────

// 2026-05-04 is a Monday. All tests use the same reference week.
const MONDAY = '2026-05-04';
const TUESDAY = '2026-05-05';
const SUNDAY = '2026-05-03';

function isoAt(dateStr, hours, minutes = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d, hours, minutes, 0, 0);
  return date.toISOString();
}

function caregiver(id, firstName, lastName = 'Test') {
  return { id, firstName, lastName };
}

function recurringAvail(dayOfWeek, startTime, endTime) {
  return { type: 'available', dayOfWeek, startTime, endTime };
}

function conflictingShift(id, startHour, endHour, clientId = 'other-client') {
  return {
    id,
    clientId,
    assignedCaregiverId: 'doesnt_matter',
    startTime: isoAt(MONDAY, startHour),
    endTime: isoAt(MONDAY, endHour),
    status: 'confirmed',
  };
}

// Week bounds for MONDAY 2026-05-04 (Sunday → Saturday)
const { start: WEEK_START, end: WEEK_END } = weekBoundsContaining(new Date(2026, 4, 4));

// ─── roleTierLabel ─────────────────────────────────────────────

describe('roleTierLabel', () => {
  it('labels each tier', () => {
    expect(roleTierLabel(ROLE_TIER_PRIMARY)).toBe('Primary');
    expect(roleTierLabel(ROLE_TIER_BACKUP)).toBe('Backup');
    expect(roleTierLabel(ROLE_TIER_FLOAT)).toBe('Float');
    expect(roleTierLabel(ROLE_TIER_NONE)).toBe('');
  });
});

// ─── weekBoundsContaining ──────────────────────────────────────

describe('weekBoundsContaining', () => {
  it('returns a 7-day window starting on Sunday', () => {
    // 2026-05-04 is Monday — week should start on 2026-05-03 (Sun)
    const { start, end } = weekBoundsContaining(new Date(2026, 4, 4));
    expect(start.getDay()).toBe(0); // Sunday
    expect(end.getDay()).toBe(6); // Saturday
    // Duration is 7 days minus 1ms
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000 - 1);
  });

  it('returns null for invalid input', () => {
    expect(weekBoundsContaining('not a date')).toBeNull();
  });
});

// ─── sumHoursInWindow ──────────────────────────────────────────

describe('sumHoursInWindow', () => {
  const start = new Date(2026, 4, 3, 0, 0, 0, 0); // Sun 00:00
  const end = new Date(2026, 4, 9, 23, 59, 59, 999); // Sat 23:59:59

  it('returns 0 for empty shifts', () => {
    expect(sumHoursInWindow([], start, end)).toBe(0);
    expect(sumHoursInWindow(null, start, end)).toBe(0);
  });

  it('sums hours for shifts entirely inside the window', () => {
    const shifts = [
      { startTime: isoAt(MONDAY, 8), endTime: isoAt(MONDAY, 12), status: 'confirmed' },
      { startTime: isoAt(TUESDAY, 9), endTime: isoAt(TUESDAY, 13), status: 'assigned' },
    ];
    expect(sumHoursInWindow(shifts, start, end)).toBe(8);
  });

  it('ignores cancelled and no_show shifts', () => {
    const shifts = [
      { startTime: isoAt(MONDAY, 8), endTime: isoAt(MONDAY, 12), status: 'cancelled' },
      { startTime: isoAt(MONDAY, 13), endTime: isoAt(MONDAY, 17), status: 'no_show' },
      { startTime: isoAt(TUESDAY, 8), endTime: isoAt(TUESDAY, 12), status: 'confirmed' },
    ];
    expect(sumHoursInWindow(shifts, start, end)).toBe(4);
  });

  it('clips shifts that start before the window', () => {
    const shifts = [
      {
        startTime: new Date(2026, 4, 2, 20, 0).toISOString(), // Sat 8pm prior week
        endTime: new Date(2026, 4, 3, 2, 0).toISOString(), // Sun 2am this week
        status: 'confirmed',
      },
    ];
    expect(sumHoursInWindow(shifts, start, end)).toBe(2);
  });

  it('includes in_progress, assigned, confirmed, completed shifts', () => {
    const shifts = [
      { startTime: isoAt(MONDAY, 8), endTime: isoAt(MONDAY, 10), status: 'assigned' },
      { startTime: isoAt(MONDAY, 10), endTime: isoAt(MONDAY, 12), status: 'confirmed' },
      { startTime: isoAt(MONDAY, 12), endTime: isoAt(MONDAY, 14), status: 'in_progress' },
      { startTime: isoAt(MONDAY, 14), endTime: isoAt(MONDAY, 16), status: 'completed' },
    ];
    expect(sumHoursInWindow(shifts, start, end)).toBe(8);
  });
});

// ─── rankCaregiversForShift ────────────────────────────────────

describe('rankCaregiversForShift — empty / invalid inputs', () => {
  it('returns empty array when proposed is missing', () => {
    expect(
      rankCaregiversForShift({
        proposed: null,
        caregivers: [caregiver('a', 'A')],
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
      }),
    ).toEqual([]);
  });

  it('returns empty array when caregivers is missing', () => {
    expect(
      rankCaregiversForShift({
        proposed: { clientId: 'c1', startTime: isoAt(MONDAY, 8), endTime: isoAt(MONDAY, 12) },
        caregivers: null,
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
      }),
    ).toEqual([]);
  });

  it('returns empty array when proposed is missing required fields', () => {
    expect(
      rankCaregiversForShift({
        proposed: { clientId: 'c1' },
        caregivers: [caregiver('a', 'A')],
        weekStart: WEEK_START,
        weekEnd: WEEK_END,
      }),
    ).toEqual([]);
  });
});

// ─── Eligibility filtering ─────────────────────────────────────

describe('rankCaregiversForShift — availability filtering', () => {
  const proposed = {
    clientId: 'client-x',
    startTime: isoAt(MONDAY, 8),
    endTime: isoAt(MONDAY, 12),
  };

  it('marks caregiver with matching recurring availability as eligible', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [caregiver('m', 'Maria')],
      availabilityByCaregiverId: {
        m: [recurringAvail(1, '08:00', '16:00')],
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result[0].eligible).toBe(true);
    expect(result[0].filterReason).toBeNull();
  });

  it('filters out caregiver with no availability data', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [caregiver('m', 'Maria')],
      availabilityByCaregiverId: { m: [] },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result[0].eligible).toBe(false);
    expect(result[0].filterReason).toBe('no_availability_data');
  });

  it('filters out caregiver whose availability does not cover the shift', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [caregiver('m', 'Maria')],
      availabilityByCaregiverId: {
        m: [recurringAvail(2, '08:00', '16:00')], // Tuesday only
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result[0].eligible).toBe(false);
    expect(result[0].filterReason).toBe('unavailable');
  });

  it('filters out caregiver with a time-off block covering the shift', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [caregiver('m', 'Maria')],
      availabilityByCaregiverId: {
        m: [
          recurringAvail(1, '08:00', '16:00'),
          { type: 'unavailable', startDate: MONDAY, endDate: MONDAY },
        ],
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result[0].eligible).toBe(false);
    expect(result[0].filterReason).toBe('unavailable');
    expect(result[0].filterDetail).toContain('time-off');
  });
});

// ─── Conflict filtering ────────────────────────────────────────

describe('rankCaregiversForShift — conflict filtering', () => {
  const proposed = {
    clientId: 'client-x',
    startTime: isoAt(MONDAY, 13),
    endTime: isoAt(MONDAY, 17),
  };

  it('filters out caregiver with a different-client conflict', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [caregiver('m', 'Maria')],
      availabilityByCaregiverId: {
        m: [recurringAvail(1, '00:00', '23:59')],
      },
      shiftsByCaregiverId: {
        m: [conflictingShift('other', 12, 14, 'different-client')],
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result[0].eligible).toBe(false);
    expect(result[0].filterReason).toBe('conflict');
    expect(result[0].conflictingShifts).toHaveLength(1);
  });

  it('does NOT filter out caregiver with a same-client back-to-back shift', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [caregiver('m', 'Maria')],
      availabilityByCaregiverId: {
        m: [recurringAvail(1, '00:00', '23:59')],
      },
      shiftsByCaregiverId: {
        m: [
          {
            id: 'earlier',
            clientId: 'client-x', // same client
            startTime: isoAt(MONDAY, 9),
            endTime: isoAt(MONDAY, 13), // ends exactly when proposed starts
            status: 'confirmed',
          },
        ],
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result[0].eligible).toBe(true);
  });

  it('excludes the current shift from self-conflict when excludeShiftId is passed via proposed.id', () => {
    const existing = {
      id: 'shift-being-edited',
      clientId: 'client-x',
      assignedCaregiverId: 'm',
      startTime: isoAt(MONDAY, 8),
      endTime: isoAt(MONDAY, 14),
      status: 'confirmed',
    };
    const result = rankCaregiversForShift({
      proposed: { ...existing, startTime: isoAt(MONDAY, 10), endTime: isoAt(MONDAY, 16) },
      caregivers: [caregiver('m', 'Maria')],
      availabilityByCaregiverId: {
        m: [recurringAvail(1, '00:00', '23:59')],
      },
      shiftsByCaregiverId: { m: [existing] },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result[0].eligible).toBe(true);
  });
});

// ─── Ranking / sort order ──────────────────────────────────────

describe('rankCaregiversForShift — sort order', () => {
  const proposed = {
    clientId: 'client-x',
    startTime: isoAt(MONDAY, 8),
    endTime: isoAt(MONDAY, 12),
  };

  const alwaysAvailable = {
    a: [recurringAvail(1, '00:00', '23:59')],
    b: [recurringAvail(1, '00:00', '23:59')],
    c: [recurringAvail(1, '00:00', '23:59')],
    d: [recurringAvail(1, '00:00', '23:59')],
  };

  it('puts eligible caregivers before filtered ones', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [caregiver('a', 'Alpha'), caregiver('b', 'Beta')],
      availabilityByCaregiverId: {
        a: [], // no data → filtered
        b: [recurringAvail(1, '08:00', '12:00')], // eligible
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result.map((r) => r.caregiver.id)).toEqual(['b', 'a']);
    expect(result[0].eligible).toBe(true);
    expect(result[1].eligible).toBe(false);
  });

  it('sorts eligible by role tier: primary → backup → float → none', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [
        caregiver('none', 'None'),
        caregiver('float', 'Float'),
        caregiver('backup', 'Backup'),
        caregiver('primary', 'Primary'),
      ],
      availabilityByCaregiverId: {
        none: [recurringAvail(1, '00:00', '23:59')],
        float: [recurringAvail(1, '00:00', '23:59')],
        backup: [recurringAvail(1, '00:00', '23:59')],
        primary: [recurringAvail(1, '00:00', '23:59')],
      },
      assignmentsByCaregiverId: {
        float: [{ clientId: 'client-x', role: 'float', status: 'active' }],
        backup: [{ clientId: 'client-x', role: 'backup', status: 'active' }],
        primary: [{ clientId: 'client-x', role: 'primary', status: 'active' }],
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result.map((r) => r.caregiver.id)).toEqual(['primary', 'backup', 'float', 'none']);
  });

  it('within the same role tier, sorts by hours-this-week ascending', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [
        caregiver('busy', 'Busy'),
        caregiver('light', 'Light'),
        caregiver('medium', 'Medium'),
      ],
      availabilityByCaregiverId: alwaysAvailable,
      shiftsByCaregiverId: {
        busy: [
          { startTime: isoAt(MONDAY, 9), endTime: isoAt(MONDAY, 15), status: 'confirmed' },
          { startTime: isoAt(TUESDAY, 8), endTime: isoAt(TUESDAY, 14), status: 'confirmed' },
        ], // 12 hours
        light: [], // 0 hours
        medium: [
          { startTime: isoAt(MONDAY, 13), endTime: isoAt(MONDAY, 17), status: 'confirmed' },
        ], // 4 hours
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result.map((r) => r.caregiver.id)).toEqual(['light', 'medium', 'busy']);
  });

  it('primary with many hours still comes before backup with fewer hours', () => {
    // Role tier takes precedence over hours — primary always first.
    // Primary's existing shifts are on Tue/Wed so they don't conflict
    // with the Monday 8-12 proposed shift.
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [caregiver('p', 'Pat'), caregiver('b', 'Bob')],
      availabilityByCaregiverId: {
        p: [recurringAvail(1, '00:00', '23:59')],
        b: [recurringAvail(1, '00:00', '23:59')],
      },
      assignmentsByCaregiverId: {
        p: [{ clientId: 'client-x', role: 'primary', status: 'active' }],
        b: [{ clientId: 'client-x', role: 'backup', status: 'active' }],
      },
      shiftsByCaregiverId: {
        p: [
          // Tue 9-19 (10h) + Wed 9-19 (10h) = 20 hrs, no conflict with Mon 8-12
          { clientId: 'client-x', startTime: isoAt(TUESDAY, 9), endTime: isoAt(TUESDAY, 19), status: 'confirmed' },
          { clientId: 'client-x', startTime: isoAt('2026-05-06', 9), endTime: isoAt('2026-05-06', 19), status: 'confirmed' },
        ],
        b: [], // 0 hrs
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result.map((r) => r.caregiver.id)).toEqual(['p', 'b']);
  });

  it('sorts alphabetically when tier and hours are tied', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [caregiver('z', 'Zoe'), caregiver('a', 'Alice')],
      availabilityByCaregiverId: {
        z: [recurringAvail(1, '00:00', '23:59')],
        a: [recurringAvail(1, '00:00', '23:59')],
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result.map((r) => r.caregiver.id)).toEqual(['a', 'z']);
  });

  it('ignores assignments for other clients', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [caregiver('m', 'Maria')],
      availabilityByCaregiverId: alwaysAvailable,
      assignmentsByCaregiverId: {
        m: [{ clientId: 'different-client', role: 'primary', status: 'active' }],
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result[0].tier).toBe(ROLE_TIER_NONE);
  });

  it('ignores ended assignments', () => {
    const result = rankCaregiversForShift({
      proposed,
      caregivers: [caregiver('m', 'Maria')],
      availabilityByCaregiverId: alwaysAvailable,
      assignmentsByCaregiverId: {
        m: [{ clientId: 'client-x', role: 'primary', status: 'ended' }],
      },
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    });
    expect(result[0].tier).toBe(ROLE_TIER_NONE);
  });
});

// ─── splitRankedList ──────────────────────────────────────────

describe('splitRankedList', () => {
  it('partitions into eligible and filtered', () => {
    const ranked = [
      { caregiver: { id: '1' }, eligible: true },
      { caregiver: { id: '2' }, eligible: false },
      { caregiver: { id: '3' }, eligible: true },
    ];
    const { eligible, filtered } = splitRankedList(ranked);
    expect(eligible.map((r) => r.caregiver.id)).toEqual(['1', '3']);
    expect(filtered.map((r) => r.caregiver.id)).toEqual(['2']);
  });

  it('handles empty / null input', () => {
    expect(splitRankedList([])).toEqual({ eligible: [], filtered: [] });
    expect(splitRankedList(null)).toEqual({ eligible: [], filtered: [] });
  });
});

// ─── formatEligibleReason ─────────────────────────────────────

describe('formatEligibleReason', () => {
  it('includes role label and hours', () => {
    const text = formatEligibleReason({
      roleLabel: 'Primary',
      hoursThisWeek: 12,
    });
    expect(text).toContain('Primary');
    expect(text).toContain('12 hrs this week');
  });

  it('falls back to "Available" when no role', () => {
    const text = formatEligibleReason({
      roleLabel: '',
      hoursThisWeek: 4,
    });
    expect(text).toContain('Available');
    expect(text).toContain('4 hrs this week');
  });

  it('uses singular "hr" for exactly 1 hour', () => {
    const text = formatEligibleReason({
      roleLabel: 'Backup',
      hoursThisWeek: 1,
    });
    expect(text).toContain('1 hr this week');
  });

  it('rounds fractional hours to one decimal', () => {
    const text = formatEligibleReason({
      roleLabel: 'Primary',
      hoursThisWeek: 3.75,
    });
    expect(text).toContain('3.8');
  });
});
