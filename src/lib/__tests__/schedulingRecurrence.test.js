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

// ─── Explicit timezone — stable across runtimes ───────────────
// When a caller passes { timezone }, the output must be deterministic
// regardless of the JS runtime's local zone — this is the whole point
// of the timezone option. Without it, the same pattern produces
// different ISO strings on a dev laptop vs. Vercel.

describe('expandRecurrence — explicit timezone', () => {
  it('08:00 PT on a Monday in May resolves to 15:00 UTC (PDT)', () => {
    const pattern = {
      frequency: 'weekly',
      days_of_week: [1],
      start_time: '08:00',
      end_time: '12:00',
    };
    const result = expandRecurrence(pattern, '2026-05-04', '2026-05-04', {
      timezone: 'America/Los_Angeles',
    });
    expect(result).toHaveLength(1);
    expect(result[0].start_time).toBe('2026-05-04T15:00:00.000Z');
    expect(result[0].end_time).toBe('2026-05-04T19:00:00.000Z');
  });

  it('08:00 PT on a Monday in January resolves to 16:00 UTC (PST)', () => {
    const pattern = {
      frequency: 'weekly',
      days_of_week: [1],
      start_time: '08:00',
      end_time: '12:00',
    };
    // 2026-01-05 is a Monday
    const result = expandRecurrence(pattern, '2026-01-05', '2026-01-05', {
      timezone: 'America/Los_Angeles',
    });
    expect(result).toHaveLength(1);
    expect(result[0].start_time).toBe('2026-01-05T16:00:00.000Z');
    expect(result[0].end_time).toBe('2026-01-05T20:00:00.000Z');
  });

  it('produces the same UTC ISO regardless of machine TZ when timezone is explicit', () => {
    const pattern = {
      frequency: 'weekly',
      days_of_week: [1],
      start_time: '08:00',
      end_time: '12:00',
    };
    // Re-running the same call multiple times is a weak test of
    // determinism, but combined with the absolute ISO assertions
    // above it pins down that no local-TZ dependency remains in the
    // DST-agnostic path.
    const a = expandRecurrence(pattern, '2026-05-04', '2026-05-04', {
      timezone: 'America/Los_Angeles',
    });
    const b = expandRecurrence(pattern, '2026-05-04', '2026-05-04', {
      timezone: 'America/Los_Angeles',
    });
    expect(a).toEqual(b);
  });
});

// ─── DST transitions (America/Los_Angeles) ────────────────────
// A caregiver with a weekly Mon 08:00-12:00 recurring shift should
// see the shift fire at 08:00 PACIFIC every Monday, even across DST
// boundaries. That means the UTC ISO moves by one hour across the
// transition, but the wall-clock intent stays stable.

describe('expandRecurrence — DST transitions', () => {
  const tz = 'America/Los_Angeles';
  const pattern = {
    frequency: 'weekly',
    days_of_week: [1],
    start_time: '08:00',
    end_time: '12:00',
  };

  it('spring-forward: Monday before (Mar 2) = PST, Monday after (Mar 9) = PDT', () => {
    // DST-start is Sunday 2026-03-08. Monday Mar 2 is PST, Monday Mar 9 is PDT.
    const result = expandRecurrence(pattern, '2026-03-02', '2026-03-09', {
      timezone: tz,
    });
    expect(result).toHaveLength(2);
    // Mar 2 08:00 PST = 16:00 UTC
    expect(result[0].start_time).toBe('2026-03-02T16:00:00.000Z');
    // Mar 9 08:00 PDT = 15:00 UTC
    expect(result[1].start_time).toBe('2026-03-09T15:00:00.000Z');
  });

  it('fall-back: Monday before (Oct 26) = PDT, Monday after (Nov 2) = PST', () => {
    // DST-end is Sunday 2026-11-01.
    const result = expandRecurrence(pattern, '2026-10-26', '2026-11-02', {
      timezone: tz,
    });
    expect(result).toHaveLength(2);
    // Oct 26 08:00 PDT = 15:00 UTC
    expect(result[0].start_time).toBe('2026-10-26T15:00:00.000Z');
    // Nov 2 08:00 PST = 16:00 UTC
    expect(result[1].start_time).toBe('2026-11-02T16:00:00.000Z');
  });

  it('a recurring shift that happens to land on DST-start Sunday still fires at 08:00 local', () => {
    // Sunday pattern; 2026-03-08 is DST-start Sunday.
    const sundayPattern = {
      frequency: 'weekly',
      days_of_week: [0],
      start_time: '08:00',
      end_time: '12:00',
    };
    const result = expandRecurrence(sundayPattern, '2026-03-08', '2026-03-08', {
      timezone: tz,
    });
    expect(result).toHaveLength(1);
    // 08:00 on DST-start morning is PDT — 15:00 UTC.
    expect(result[0].start_time).toBe('2026-03-08T15:00:00.000Z');
  });
});
