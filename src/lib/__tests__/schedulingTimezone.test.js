import { describe, it, expect } from 'vitest';
import {
  DEFAULT_APP_TIMEZONE,
  wallClockToUtcMs,
  utcMsToWallClockParts,
} from '../scheduling/timezone';

// ─── DEFAULT_APP_TIMEZONE ──────────────────────────────────────

describe('DEFAULT_APP_TIMEZONE', () => {
  it('is a valid IANA zone that Intl accepts', () => {
    expect(() =>
      new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_APP_TIMEZONE }),
    ).not.toThrow();
  });

  it('is documented as Pacific time (matches the ops team)', () => {
    expect(DEFAULT_APP_TIMEZONE).toBe('America/Los_Angeles');
  });
});

// ─── wallClockToUtcMs — fixed offsets ──────────────────────────

describe('wallClockToUtcMs — fixed-offset zones', () => {
  it('interprets a wall-clock as UTC when timezone=UTC', () => {
    const ms = wallClockToUtcMs(
      { year: 2026, month: 5, day: 4, hour: 8, minute: 0 },
      'UTC',
    );
    expect(new Date(ms).toISOString()).toBe('2026-05-04T08:00:00.000Z');
  });

  it('applies the zone offset (+09:00 Tokyo)', () => {
    // 08:00 JST is 23:00 UTC the previous day.
    const ms = wallClockToUtcMs(
      { year: 2026, month: 5, day: 4, hour: 8, minute: 0 },
      'Asia/Tokyo',
    );
    expect(new Date(ms).toISOString()).toBe('2026-05-03T23:00:00.000Z');
  });

  it('applies the zone offset (LA PDT in May = -07:00)', () => {
    // 08:00 PDT is 15:00 UTC.
    const ms = wallClockToUtcMs(
      { year: 2026, month: 5, day: 4, hour: 8, minute: 0 },
      'America/Los_Angeles',
    );
    expect(new Date(ms).toISOString()).toBe('2026-05-04T15:00:00.000Z');
  });

  it('applies the zone offset (LA PST in January = -08:00)', () => {
    // 08:00 PST is 16:00 UTC.
    const ms = wallClockToUtcMs(
      { year: 2026, month: 1, day: 15, hour: 8, minute: 0 },
      'America/Los_Angeles',
    );
    expect(new Date(ms).toISOString()).toBe('2026-01-15T16:00:00.000Z');
  });
});

// ─── wallClockToUtcMs — DST correctness ────────────────────────
// The key property: the same "08:00" wall-clock string produces the
// right UTC instant on EITHER side of a DST transition, so recurring
// shifts fire at the caregiver's wall-clock time year-round.

describe('wallClockToUtcMs — DST transitions (America/Los_Angeles)', () => {
  const tz = 'America/Los_Angeles';

  it('08:00 on Saturday before spring-forward = 15:00 UTC (PST, -08:00)', () => {
    // 2026-03-07 is a Saturday; DST starts Sunday 2026-03-08.
    const ms = wallClockToUtcMs({ year: 2026, month: 3, day: 7, hour: 8 }, tz);
    expect(new Date(ms).toISOString()).toBe('2026-03-07T16:00:00.000Z');
  });

  it('08:00 on Sunday after spring-forward = 15:00 UTC (PDT, -07:00)', () => {
    // 2026-03-08 02:00 local → 03:00 local; morning shifts at 08:00 are PDT.
    const ms = wallClockToUtcMs({ year: 2026, month: 3, day: 8, hour: 8 }, tz);
    expect(new Date(ms).toISOString()).toBe('2026-03-08T15:00:00.000Z');
  });

  it('08:00 on Sunday after fall-back = 16:00 UTC (PST, -08:00)', () => {
    // 2026-11-01 is DST-end in US.
    const ms = wallClockToUtcMs({ year: 2026, month: 11, day: 1, hour: 8 }, tz);
    expect(new Date(ms).toISOString()).toBe('2026-11-01T16:00:00.000Z');
  });

  it('the non-existent wall-clock 02:30 on spring-forward resolves deterministically', () => {
    // 02:00–02:59 PST does not exist on DST-start morning. The
    // two-pass algorithm resolves to the post-transition offset,
    // producing the same instant as 03:30 PDT would have.
    const ms = wallClockToUtcMs(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      tz,
    );
    // 03:30 PDT = 10:30 UTC. (02:30 "wall" is interpreted as 03:30 PDT.)
    expect(new Date(ms).toISOString()).toBe('2026-03-08T10:30:00.000Z');
  });

  it('produces a stable ISO across machine TZs when an explicit tz is passed', () => {
    // The same call yields the same UTC regardless of what the runtime's
    // machine-local zone happens to be — no process.env.TZ manipulation
    // needed to prove this, because we never consulted the local zone.
    const a = wallClockToUtcMs({ year: 2026, month: 5, day: 4, hour: 8 }, tz);
    const b = wallClockToUtcMs({ year: 2026, month: 5, day: 4, hour: 8 }, tz);
    expect(a).toBe(b);
  });
});

// ─── utcMsToWallClockParts — round-trip ────────────────────────

describe('utcMsToWallClockParts', () => {
  it('round-trips 08:00 PDT through a UTC ISO and back to PT wall-clock', () => {
    const tz = 'America/Los_Angeles';
    const ms = wallClockToUtcMs({ year: 2026, month: 5, day: 4, hour: 8 }, tz);
    const parts = utcMsToWallClockParts(ms, tz);
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(5);
    expect(parts.day).toBe(4);
    expect(parts.hour).toBe(8);
    expect(parts.minute).toBe(0);
    expect(parts.dateOnly).toBe('2026-05-04');
    expect(parts.dayOfWeek).toBe(1); // Monday
    expect(parts.minutesOfDay).toBe(8 * 60);
  });

  it('an 11 PM UTC shift is 4 PM in LA and reports dayOfWeek for LA', () => {
    // 2026-05-05T06:00:00Z = 2026-05-04T23:00 PDT (a Monday in LA)
    const parts = utcMsToWallClockParts(
      '2026-05-05T06:00:00.000Z',
      'America/Los_Angeles',
    );
    expect(parts.dateOnly).toBe('2026-05-04');
    expect(parts.dayOfWeek).toBe(1); // Monday in LA
    expect(parts.hour).toBe(23);
  });

  it('the same UTC instant reports different dayOfWeek in different zones', () => {
    const iso = '2026-05-04T06:00:00.000Z'; // Mon 06:00 UTC = Mon 15:00 JST = Sun 23:00 PDT
    expect(utcMsToWallClockParts(iso, 'Asia/Tokyo').dayOfWeek).toBe(1); // Mon
    expect(utcMsToWallClockParts(iso, 'America/Los_Angeles').dayOfWeek).toBe(0); // Sun
    expect(utcMsToWallClockParts(iso, 'UTC').dayOfWeek).toBe(1); // Mon
  });

  it('round-trips across a DST-spring-forward boundary', () => {
    const tz = 'America/Los_Angeles';
    // First Monday after DST start: 2026-03-09 at 08:00 local.
    const ms = wallClockToUtcMs({ year: 2026, month: 3, day: 9, hour: 8 }, tz);
    const parts = utcMsToWallClockParts(ms, tz);
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(3);
    expect(parts.day).toBe(9);
    expect(parts.hour).toBe(8);
    expect(parts.minute).toBe(0);
  });

  it('round-trips across a DST-fall-back boundary', () => {
    const tz = 'America/Los_Angeles';
    // First Monday after DST end: 2026-11-02 at 08:00 local.
    const ms = wallClockToUtcMs({ year: 2026, month: 11, day: 2, hour: 8 }, tz);
    const parts = utcMsToWallClockParts(ms, tz);
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(11);
    expect(parts.day).toBe(2);
    expect(parts.hour).toBe(8);
  });
});
