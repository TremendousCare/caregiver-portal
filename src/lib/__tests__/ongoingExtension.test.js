import { describe, it, expect } from 'vitest';
import {
  computeOngoingExtensionWindow,
  dayFloorUtc,
  latestEndTime,
} from '../scheduling/ongoingExtension';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const NOW = new Date('2026-05-04T12:00:00.000Z');

describe('computeOngoingExtensionWindow', () => {
  it('extends from now when the plan has never been generated', () => {
    const decision = computeOngoingExtensionWindow({ last_generated_through: null }, NOW);
    expect(decision.shouldExtend).toBe(true);
    expect(decision.reason).toBe('no-prior-generation');
    expect(decision.windowStart.getTime()).toBe(NOW.getTime());
    // 84 days = 12 weeks
    expect(decision.windowEnd.getTime()).toBe(NOW.getTime() + 84 * MS_PER_DAY);
  });

  it('skips when runway already exceeds the buffer', () => {
    const lastGen = new Date(NOW.getTime() + 60 * MS_PER_DAY); // 60 days ahead
    const decision = computeOngoingExtensionWindow(
      { last_generated_through: lastGen.toISOString() },
      NOW,
    );
    expect(decision.shouldExtend).toBe(false);
    expect(decision.reason).toBe('sufficient-runway');
  });

  it('extends from the last generated point when runway dropped below buffer', () => {
    // Default buffer is 28 days. 21 days of runway is below buffer.
    const lastGen = new Date(NOW.getTime() + 21 * MS_PER_DAY);
    const decision = computeOngoingExtensionWindow(
      { last_generated_through: lastGen.toISOString() },
      NOW,
    );
    expect(decision.shouldExtend).toBe(true);
    expect(decision.reason).toBe('topping-up');
    // Resume a hair after the prior boundary so we don't re-emit the
    // shift whose end_time is exactly that point.
    expect(decision.windowStart.getTime()).toBe(lastGen.getTime() + 1);
    expect(decision.windowEnd.getTime()).toBe(NOW.getTime() + 84 * MS_PER_DAY);
  });

  it('respects custom target and buffer days', () => {
    const lastGen = new Date(NOW.getTime() + 5 * MS_PER_DAY);
    const decision = computeOngoingExtensionWindow(
      { last_generated_through: lastGen.toISOString() },
      NOW,
      { targetDays: 14, bufferDays: 7 },
    );
    expect(decision.shouldExtend).toBe(true);
    expect(decision.windowEnd.getTime()).toBe(NOW.getTime() + 14 * MS_PER_DAY);
  });

  it('skips when last_generated_through is somehow past the new target', () => {
    const lastGen = new Date(NOW.getTime() + 200 * MS_PER_DAY);
    const decision = computeOngoingExtensionWindow(
      { last_generated_through: lastGen.toISOString() },
      NOW,
    );
    expect(decision.shouldExtend).toBe(false);
  });

  it('treats invalid last_generated_through as "no prior generation"', () => {
    const decision = computeOngoingExtensionWindow(
      { last_generated_through: 'not-a-date' },
      NOW,
    );
    expect(decision.shouldExtend).toBe(true);
    expect(decision.reason).toBe('no-prior-generation');
  });

  it('returns no-extend for an invalid `now` input', () => {
    const decision = computeOngoingExtensionWindow({ last_generated_through: null }, 'nope');
    expect(decision.shouldExtend).toBe(false);
    expect(decision.reason).toBe('invalid-now');
  });

  it('accepts a numeric `now` (ms since epoch) for convenience', () => {
    const decision = computeOngoingExtensionWindow(
      { last_generated_through: null },
      NOW.getTime(),
    );
    expect(decision.shouldExtend).toBe(true);
    expect(decision.windowEnd.getTime()).toBe(NOW.getTime() + 84 * MS_PER_DAY);
  });
});

describe('dayFloorUtc', () => {
  it('floors a mid-day Date to UTC midnight', () => {
    const out = dayFloorUtc(new Date('2026-08-04T12:34:56.789Z'));
    expect(out.toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });

  it('is a no-op when the input is already UTC midnight', () => {
    const out = dayFloorUtc(new Date('2026-08-04T00:00:00.000Z'));
    expect(out.toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });

  it('accepts a numeric ms-since-epoch input', () => {
    const ms = new Date('2026-08-04T18:00:00.000Z').getTime();
    expect(dayFloorUtc(ms).toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });

  it('returns null for invalid input', () => {
    expect(dayFloorUtc('not a date')).toBeNull();
    expect(dayFloorUtc(null)).toBeNull();
  });

  it('mirrors expandRecurrence boundary handling — a `last_generated_through + 1ms` window start floors back to the start of the same UTC day so the dedupe SQL can catch boundary-day shifts', () => {
    // Pin the documented invariant that the cron relies on: the
    // dedupe lower bound used by the edge function MUST be the start
    // of the UTC day, not the un-floored windowStart, otherwise an
    // 08:00 shift on the boundary day slips past the SQL filter and
    // gets re-inserted as a duplicate.
    const lastGeneratedThrough = new Date('2026-08-04T12:00:00.000Z');
    const windowStart = new Date(lastGeneratedThrough.getTime() + 1);
    const lower = dayFloorUtc(windowStart).toISOString();
    expect(lower).toBe('2026-08-04T00:00:00.000Z');
    // Sanity-check: an existing 08:00 shift falls inside the lower
    // bound but would NOT have if we'd used windowStart directly.
    const existingShiftStart = '2026-08-04T08:00:00.000Z';
    expect(existingShiftStart >= lower).toBe(true);
    expect(existingShiftStart >= windowStart.toISOString()).toBe(false);
  });
});

describe('latestEndTime', () => {
  it('returns null for empty / invalid input', () => {
    expect(latestEndTime([])).toBeNull();
    expect(latestEndTime(null)).toBeNull();
  });

  it('returns the maximum end_time as an ISO string', () => {
    const out = latestEndTime([
      { end_time: '2026-05-10T12:00:00.000Z' },
      { end_time: '2026-06-01T08:00:00.000Z' },
      { end_time: '2026-04-22T18:00:00.000Z' },
    ]);
    expect(out).toBe('2026-06-01T08:00:00.000Z');
  });

  it('skips entries with missing or unparseable end_time', () => {
    const out = latestEndTime([
      { end_time: null },
      { end_time: '2026-05-10T12:00:00.000Z' },
      { end_time: 'garbage' },
    ]);
    expect(out).toBe('2026-05-10T12:00:00.000Z');
  });
});
