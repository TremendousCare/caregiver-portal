import { describe, it, expect } from 'vitest';
import {
  isAvailable,
  filterAvailableCaregivers,
} from '../scheduling/availabilityMatching';

// Helper: build a UTC ISO timestamp for a specific day/hour
// 2026-05-04 is a Monday. Day-of-week = 1.
function t(dateStr, hours, minutes = 0) {
  const h = String(hours).padStart(2, '0');
  const m = String(minutes).padStart(2, '0');
  return `${dateStr}T${h}:${m}:00.000Z`;
}

// ─── Constants ─────────────────────────────────────────────────
const MON = '2026-05-04'; // dayOfWeek=1
const TUE = '2026-05-05'; // dayOfWeek=2
const WED = '2026-05-06'; // dayOfWeek=3
const SUN = '2026-05-03'; // dayOfWeek=0

// ─── Recurring availability tests ──────────────────────────────

describe('isAvailable — recurring weekly', () => {
  it('returns false when no availability data is provided', () => {
    const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };
    expect(isAvailable(shift, [])).toEqual({
      available: false,
      reason: 'no_data',
    });
  });

  it('returns false when availability list is null', () => {
    const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };
    expect(isAvailable(shift, null)).toEqual({
      available: false,
      reason: 'no_data',
    });
  });

  it('matches a recurring Monday 8-12 availability for a Monday shift', () => {
    const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };
    const rows = [
      {
        type: 'available',
        day_of_week: 1, // Monday
        start_time: '08:00',
        end_time: '12:00',
      },
    ];
    expect(isAvailable(shift, rows)).toEqual({ available: true, reason: null });
  });

  it('matches when shift is wholly inside the recurring window', () => {
    const shift = { start_time: t(MON, 9), end_time: t(MON, 11) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
    ];
    expect(isAvailable(shift, rows).available).toBe(true);
  });

  it('rejects a shift that ends after availability ends', () => {
    const shift = { start_time: t(MON, 11), end_time: t(MON, 13) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
    ];
    expect(isAvailable(shift, rows)).toEqual({
      available: false,
      reason: 'outside_availability',
    });
  });

  it('rejects a shift that starts before availability starts', () => {
    const shift = { start_time: t(MON, 7), end_time: t(MON, 10) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
    ];
    expect(isAvailable(shift, rows).available).toBe(false);
  });

  it('rejects a Tuesday shift when only Monday availability exists', () => {
    const shift = { start_time: t(TUE, 8), end_time: t(TUE, 12) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
    ];
    expect(isAvailable(shift, rows).available).toBe(false);
  });

  it('matches across multiple availability rows (different days)', () => {
    const shift = { start_time: t(WED, 14), end_time: t(WED, 18) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
      { type: 'available', day_of_week: 3, start_time: '12:00', end_time: '20:00' },
    ];
    expect(isAvailable(shift, rows).available).toBe(true);
  });

  it('does not cross-combine rows: a shift that spans two availability windows on the same day is NOT covered by either alone', () => {
    // Rule: for Phase 2 we require a single availability row to cover
    // the full window. If your team's 8-12 and 12-16 blocks need to
    // chain for an 8-16 shift, we'll add multi-row chaining in a later
    // phase. This test pins the current behavior.
    const shift = { start_time: t(MON, 8), end_time: t(MON, 16) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
      { type: 'available', day_of_week: 1, start_time: '12:00', end_time: '16:00' },
    ];
    expect(isAvailable(shift, rows).available).toBe(false);
  });

  it('respects effective_from (availability not yet active)', () => {
    const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };
    const rows = [
      {
        type: 'available',
        day_of_week: 1,
        start_time: '08:00',
        end_time: '12:00',
        effective_from: '2026-06-01', // future date
      },
    ];
    expect(isAvailable(shift, rows).available).toBe(false);
  });

  it('respects effective_until (availability has expired)', () => {
    const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };
    const rows = [
      {
        type: 'available',
        day_of_week: 1,
        start_time: '08:00',
        end_time: '12:00',
        effective_until: '2026-04-01', // past date
      },
    ];
    expect(isAvailable(shift, rows).available).toBe(false);
  });

  it('matches inside the effective window', () => {
    const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };
    const rows = [
      {
        type: 'available',
        day_of_week: 1,
        start_time: '08:00',
        end_time: '12:00',
        effective_from: '2026-04-01',
        effective_until: '2026-12-31',
      },
    ];
    expect(isAvailable(shift, rows).available).toBe(true);
  });
});

// ─── One-off date range tests ──────────────────────────────────

describe('isAvailable — one-off date ranges', () => {
  it('covers a shift when the date is within the one-off range (no clock limits)', () => {
    const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };
    const rows = [
      {
        type: 'available',
        start_date: '2026-05-01',
        end_date: '2026-05-31',
      },
    ];
    expect(isAvailable(shift, rows).available).toBe(true);
  });

  it('rejects a shift outside the date range', () => {
    const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };
    const rows = [
      {
        type: 'available',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
      },
    ];
    expect(isAvailable(shift, rows).available).toBe(false);
  });

  it('applies clock-time limits on one-off rows (covered)', () => {
    const shift = { start_time: t(MON, 9), end_time: t(MON, 11) };
    const rows = [
      {
        type: 'available',
        start_date: '2026-05-04',
        end_date: '2026-05-04',
        start_time: '08:00',
        end_time: '12:00',
      },
    ];
    expect(isAvailable(shift, rows).available).toBe(true);
  });

  it('applies clock-time limits on one-off rows (rejected)', () => {
    const shift = { start_time: t(MON, 13), end_time: t(MON, 15) };
    const rows = [
      {
        type: 'available',
        start_date: '2026-05-04',
        end_date: '2026-05-04',
        start_time: '08:00',
        end_time: '12:00',
      },
    ];
    expect(isAvailable(shift, rows).available).toBe(false);
  });
});

// ─── Unavailable rows override ─────────────────────────────────

describe('isAvailable — unavailable overrides', () => {
  it('an unavailable row blocks a recurring-available match', () => {
    const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '00:00', end_time: '23:59' },
      {
        type: 'unavailable',
        start_date: '2026-05-04',
        end_date: '2026-05-04',
      },
    ];
    expect(isAvailable(shift, rows)).toEqual({
      available: false,
      reason: 'unavailable_block',
    });
  });

  it('a multi-day unavailable range blocks shifts in the middle', () => {
    const shift = { start_time: t(TUE, 10), end_time: t(TUE, 14) };
    const rows = [
      { type: 'available', day_of_week: 2, start_time: '00:00', end_time: '23:59' },
      {
        type: 'unavailable',
        start_date: '2026-05-03',
        end_date: '2026-05-07',
      },
    ];
    expect(isAvailable(shift, rows).available).toBe(false);
  });

  it('a recurring unavailable row blocks a matching day-of-week shift', () => {
    const shift = { start_time: t(MON, 10), end_time: t(MON, 11) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '00:00', end_time: '23:59' },
      { type: 'unavailable', day_of_week: 1, start_time: '09:00', end_time: '12:00' },
    ];
    expect(isAvailable(shift, rows).available).toBe(false);
  });

  it('an unavailable row on a different day does not block', () => {
    const shift = { start_time: t(MON, 10), end_time: t(MON, 11) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '00:00', end_time: '23:59' },
      { type: 'unavailable', day_of_week: 2, start_time: '09:00', end_time: '12:00' },
    ];
    expect(isAvailable(shift, rows).available).toBe(true);
  });
});

// ─── filterAvailableCaregivers ─────────────────────────────────

describe('filterAvailableCaregivers', () => {
  const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };

  it('returns empty array for null input', () => {
    expect(filterAvailableCaregivers(shift, null, {})).toEqual([]);
  });

  it('returns only caregivers who are available', () => {
    const caregivers = [
      { id: 'maria' },
      { id: 'tom' },
      { id: 'alice' },
    ];
    const availabilityByCaregiverId = {
      maria: [
        { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '16:00' },
      ],
      tom: [
        // No Monday availability
        { type: 'available', day_of_week: 2, start_time: '08:00', end_time: '16:00' },
      ],
      alice: [
        { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '16:00' },
        { type: 'unavailable', start_date: '2026-05-04', end_date: '2026-05-04' },
      ],
    };
    const result = filterAvailableCaregivers(shift, caregivers, availabilityByCaregiverId);
    expect(result.map((c) => c.id)).toEqual(['maria']);
  });

  it('handles caregivers with no availability data gracefully', () => {
    const caregivers = [{ id: 'new' }];
    const result = filterAvailableCaregivers(shift, caregivers, {});
    expect(result).toEqual([]);
  });
});

// ─── Edge cases ────────────────────────────────────────────────

describe('isAvailable — edge cases', () => {
  it('rejects when start_time is after end_time', () => {
    const shift = { start_time: t(MON, 12), end_time: t(MON, 8) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
    ];
    expect(isAvailable(shift, rows).reason).toBe('no_data');
  });

  it('rejects when start_time === end_time (zero-duration)', () => {
    const shift = { start_time: t(MON, 10), end_time: t(MON, 10) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
    ];
    expect(isAvailable(shift, rows).reason).toBe('no_data');
  });

  it('ignores rows with invalid clock strings', () => {
    const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };
    const rows = [
      { type: 'available', day_of_week: 1, start_time: 'bogus', end_time: '12:00' },
    ];
    expect(isAvailable(shift, rows).available).toBe(false);
  });

  it('supports day_of_week 0 (Sunday)', () => {
    const shift = { start_time: t(SUN, 8), end_time: t(SUN, 12) };
    const rows = [
      { type: 'available', day_of_week: 0, start_time: '08:00', end_time: '12:00' },
    ];
    expect(isAvailable(shift, rows).available).toBe(true);
  });

  it('ignores malformed rows without crashing', () => {
    const shift = { start_time: t(MON, 8), end_time: t(MON, 12) };
    const rows = [
      null,
      undefined,
      {}, // missing everything
      { type: 'available' }, // no day_of_week or dates
      { type: 'available', day_of_week: 1, start_time: '08:00', end_time: '12:00' },
    ];
    expect(isAvailable(shift, rows).available).toBe(true);
  });
});
