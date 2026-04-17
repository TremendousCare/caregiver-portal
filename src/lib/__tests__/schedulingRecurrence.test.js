import { describe, it, expect } from 'vitest';
import { expandRecurrence } from '../scheduling/recurrence';

// ─── Basic weekly expansion ────────────────────────────────────

describe('expandRecurrence — basic', () => {
  it('returns empty array for missing pattern', () => {
    expect(expandRecurrence(null, '2026-05-01', '2026-05-31')).toEqual([]);
  });

  it('returns empty array for unsupported frequency', () => {
    expect(
      expandRecurrence(
        {
          frequency: 'monthly',
          days_of_week: [1],
          start_time: '08:00',
          end_time: '12:00',
        },
        '2026-05-01',
        '2026-05-31',
      ),
    ).toEqual([]);
  });

  it('returns empty array for empty days_of_week', () => {
    expect(
      expandRecurrence(
        {
          frequency: 'weekly',
          days_of_week: [],
          start_time: '08:00',
          end_time: '12:00',
        },
        '2026-05-01',
        '2026-05-31',
      ),
    ).toEqual([]);
  });

  it('returns empty array for invalid day values', () => {
    expect(
      expandRecurrence(
        {
          frequency: 'weekly',
          days_of_week: [7],
          start_time: '08:00',
          end_time: '12:00',
        },
        '2026-05-01',
        '2026-05-31',
      ),
    ).toEqual([]);
  });

  it('returns empty array when end before start', () => {
    const result = expandRecurrence(
      {
        frequency: 'weekly',
        days_of_week: [1],
        start_time: '08:00',
        end_time: '12:00',
      },
      '2026-05-31',
      '2026-05-01',
    );
    expect(result).toEqual([]);
  });
});

// ─── Weekly: single day of week ────────────────────────────────

describe('expandRecurrence — weekly single day', () => {
  // 2026-05-04 is Monday. Mondays in May 2026: 4, 11, 18, 25.
  const pattern = {
    frequency: 'weekly',
    days_of_week: [1], // Mon
    start_time: '08:00',
    end_time: '12:00',
  };

  it('expands to 4 Mondays in May 2026', () => {
    const result = expandRecurrence(pattern, '2026-05-01', '2026-05-31');
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.date)).toEqual([
      '2026-05-04',
      '2026-05-11',
      '2026-05-18',
      '2026-05-25',
    ]);
  });

  it('builds ISO timestamps at the specified LOCAL clock time', () => {
    const result = expandRecurrence(pattern, '2026-05-04', '2026-05-04');
    expect(result).toHaveLength(1);
    // Verify the result represents 8am and 12pm in the local timezone
    // (not hardcoded UTC, since the fix in Phase 7 builds in local time)
    const start = new Date(result[0].start_time);
    expect(start.getHours()).toBe(8);
    expect(start.getMinutes()).toBe(0);
    const end = new Date(result[0].end_time);
    expect(end.getHours()).toBe(12);
    expect(end.getMinutes()).toBe(0);
  });

  it('returns empty if the window contains no matching days', () => {
    // Tue 2026-05-05 → Wed 2026-05-06 — no Mondays
    const result = expandRecurrence(pattern, '2026-05-05', '2026-05-06');
    expect(result).toEqual([]);
  });
});

// ─── Weekly: multiple days of week ─────────────────────────────

describe('expandRecurrence — weekly multi-day', () => {
  // Mon/Wed/Fri pattern
  const pattern = {
    frequency: 'weekly',
    days_of_week: [1, 3, 5],
    start_time: '09:00',
    end_time: '17:00',
  };

  it('expands to Mon/Wed/Fri within a single week', () => {
    // 2026-05-04 (Mon) through 2026-05-10 (Sun)
    const result = expandRecurrence(pattern, '2026-05-04', '2026-05-10');
    expect(result.map((r) => r.date)).toEqual([
      '2026-05-04', // Mon
      '2026-05-06', // Wed
      '2026-05-08', // Fri
    ]);
  });

  it('expands to 12 instances over 4 weeks (3 days/week)', () => {
    const result = expandRecurrence(pattern, '2026-05-04', '2026-05-31');
    expect(result).toHaveLength(12);
  });
});

// ─── Pattern start_date / end_date ─────────────────────────────

describe('expandRecurrence — pattern bounds', () => {
  const pattern = {
    frequency: 'weekly',
    days_of_week: [1],
    start_time: '08:00',
    end_time: '12:00',
    start_date: '2026-05-11',
    end_date: '2026-05-18',
  };

  it('honors pattern.start_date (skips earlier Mondays)', () => {
    const result = expandRecurrence(pattern, '2026-05-01', '2026-05-31');
    expect(result.map((r) => r.date)).toEqual(['2026-05-11', '2026-05-18']);
  });

  it('honors pattern.end_date (skips later Mondays)', () => {
    const result = expandRecurrence(
      { ...pattern, end_date: '2026-05-11' },
      '2026-05-01',
      '2026-05-31',
    );
    expect(result.map((r) => r.date)).toEqual(['2026-05-11']);
  });

  it('pattern with open-ended end_date honors only window end', () => {
    const result = expandRecurrence(
      {
        frequency: 'weekly',
        days_of_week: [1],
        start_time: '08:00',
        end_time: '12:00',
        start_date: '2026-05-04',
      },
      '2026-05-01',
      '2026-05-18',
    );
    expect(result.map((r) => r.date)).toEqual([
      '2026-05-04',
      '2026-05-11',
      '2026-05-18',
    ]);
  });
});

// ─── Exceptions ────────────────────────────────────────────────

describe('expandRecurrence — exceptions', () => {
  const pattern = {
    frequency: 'weekly',
    days_of_week: [1],
    start_time: '08:00',
    end_time: '12:00',
    exceptions: ['2026-05-11', '2026-05-18'],
  };

  it('skips excepted dates', () => {
    const result = expandRecurrence(pattern, '2026-05-01', '2026-05-31');
    expect(result.map((r) => r.date)).toEqual(['2026-05-04', '2026-05-25']);
  });

  it('ignores exception dates that fall outside the window anyway', () => {
    const pat = {
      frequency: 'weekly',
      days_of_week: [1],
      start_time: '08:00',
      end_time: '12:00',
      exceptions: ['2027-01-01'],
    };
    const result = expandRecurrence(pat, '2026-05-01', '2026-05-31');
    expect(result).toHaveLength(4);
  });
});

// ─── Window intersection ───────────────────────────────────────

describe('expandRecurrence — window intersection', () => {
  it('only returns dates inside [windowStart, windowEnd]', () => {
    const pattern = {
      frequency: 'weekly',
      days_of_week: [1, 2, 3, 4, 5, 6, 0], // every day
      start_time: '10:00',
      end_time: '11:00',
    };
    const result = expandRecurrence(pattern, '2026-05-05', '2026-05-08');
    expect(result.map((r) => r.date)).toEqual([
      '2026-05-05',
      '2026-05-06',
      '2026-05-07',
      '2026-05-08',
    ]);
  });
});

// ─── Edge cases ────────────────────────────────────────────────

describe('expandRecurrence — edge cases', () => {
  it('handles single-day window (start == end)', () => {
    const pattern = {
      frequency: 'weekly',
      days_of_week: [1],
      start_time: '08:00',
      end_time: '12:00',
    };
    const result = expandRecurrence(pattern, '2026-05-04', '2026-05-04');
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-05-04');
  });

  it('preserves the LOCAL clock time across months', () => {
    const pattern = {
      frequency: 'weekly',
      days_of_week: [1],
      start_time: '14:30',
      end_time: '18:45',
    };
    const result = expandRecurrence(pattern, '2026-05-01', '2026-06-30');
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      const start = new Date(r.start_time);
      expect(start.getHours()).toBe(14);
      expect(start.getMinutes()).toBe(30);
      const end = new Date(r.end_time);
      expect(end.getHours()).toBe(18);
      expect(end.getMinutes()).toBe(45);
    }
  });

  it('handles Sunday (day_of_week = 0)', () => {
    const pattern = {
      frequency: 'weekly',
      days_of_week: [0],
      start_time: '10:00',
      end_time: '14:00',
    };
    const result = expandRecurrence(pattern, '2026-05-01', '2026-05-31');
    // Sundays in May 2026: 3, 10, 17, 24, 31
    expect(result.map((r) => r.date)).toEqual([
      '2026-05-03',
      '2026-05-10',
      '2026-05-17',
      '2026-05-24',
      '2026-05-31',
    ]);
  });
});
