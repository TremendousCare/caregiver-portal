// Tests for Phase 1 client-sequence quiet-hours gating.
//
// The cron job in supabase/functions/automation-cron/index.ts uses
// these helpers to decide whether to execute a drip-campaign step
// right now or defer it to the next active window. The helpers are
// hardcoded to "9am-7pm America/Los_Angeles, every day of the week".
//
// These tests pin both the constants and the boundary behavior, so
// an accidental tweak to the active window (e.g. changing 19 → 18 or
// flipping to a non-LA tz) fails CI before production.

import { describe, it, expect } from 'vitest';
import {
  CLIENT_SEQUENCE_QUIET_HOURS_TZ,
  CLIENT_SEQUENCE_QUIET_HOURS_START_HOUR,
  CLIENT_SEQUENCE_QUIET_HOURS_END_HOUR,
  isClientSequenceInQuietHours,
  nextClientSequenceSendTime,
} from '../../../supabase/functions/_shared/helpers/clientSequenceQuietHours.ts';

// Fixture-time legend (PDT = UTC-7, in effect for 2026-05-23):
//   2026-05-23T04:00:00Z  →  9:00 PM PDT on 2026-05-22 (Friday)
//   2026-05-23T07:00:00Z  →  12:00 AM PDT on 2026-05-23 (Saturday)
//   2026-05-23T16:00:00Z  →  9:00 AM PDT on 2026-05-23 (Saturday)
//   2026-05-23T19:00:00Z  →  12:00 PM PDT on 2026-05-23 (Saturday)
//   2026-05-24T02:00:00Z  →  7:00 PM PDT on 2026-05-23 (Saturday)
//   2026-05-24T01:59:00Z  →  6:59 PM PDT on 2026-05-23 (Saturday)
const LA_TZ = 'America/Los_Angeles';

describe('Phase 1 client-sequence quiet-hours config', () => {
  it('pins the timezone to America/Los_Angeles', () => {
    expect(CLIENT_SEQUENCE_QUIET_HOURS_TZ).toBe(LA_TZ);
  });

  it('pins the active window to 9am-7pm PT (quiet 19→9)', () => {
    expect(CLIENT_SEQUENCE_QUIET_HOURS_START_HOUR).toBe(19);
    expect(CLIENT_SEQUENCE_QUIET_HOURS_END_HOUR).toBe(9);
  });
});

describe('isClientSequenceInQuietHours', () => {
  describe('inside the active window (sendable)', () => {
    it('is NOT quiet at 9:00am PT exactly (window opens)', () => {
      // 9am PDT = 16:00 UTC
      const t = new Date('2026-05-23T16:00:00Z');
      expect(isClientSequenceInQuietHours(t)).toBe(false);
    });

    it('is NOT quiet at noon PT', () => {
      const t = new Date('2026-05-23T19:00:00Z');
      expect(isClientSequenceInQuietHours(t)).toBe(false);
    });

    it('is NOT quiet at 6:59pm PT (last sendable minute)', () => {
      // 6:59pm PDT = 01:59 UTC next day
      const t = new Date('2026-05-24T01:59:00Z');
      expect(isClientSequenceInQuietHours(t)).toBe(false);
    });
  });

  describe('inside the quiet window (deferred)', () => {
    it('is quiet at 7:00pm PT exactly (window closes — endHour exclusive on the active side)', () => {
      // 7pm PDT = 02:00 UTC next day
      const t = new Date('2026-05-24T02:00:00Z');
      expect(isClientSequenceInQuietHours(t)).toBe(true);
    });

    it('is quiet at 9:00pm PT', () => {
      const t = new Date('2026-05-23T04:00:00Z'); // 9pm PDT prev day
      expect(isClientSequenceInQuietHours(t)).toBe(true);
    });

    it('is quiet at midnight PT', () => {
      const t = new Date('2026-05-23T07:00:00Z');
      expect(isClientSequenceInQuietHours(t)).toBe(true);
    });

    it('is quiet at 3:00am PT', () => {
      const t = new Date('2026-05-23T10:00:00Z');
      expect(isClientSequenceInQuietHours(t)).toBe(true);
    });

    it('is quiet at 8:59am PT (last quiet minute)', () => {
      // 8:59am PDT = 15:59 UTC
      const t = new Date('2026-05-23T15:59:00Z');
      expect(isClientSequenceInQuietHours(t)).toBe(true);
    });
  });

  describe('weekends are in-window (no day-of-week gating)', () => {
    it('is NOT quiet on a Saturday at noon PT', () => {
      // 2026-05-23 is a Saturday; noon PDT = 19:00 UTC
      const saturdayNoon = new Date('2026-05-23T19:00:00Z');
      expect(saturdayNoon.getUTCDay()).toBe(6); // sanity: Saturday
      expect(isClientSequenceInQuietHours(saturdayNoon)).toBe(false);
    });

    it('is NOT quiet on a Sunday at 2pm PT', () => {
      // 2026-05-24 is a Sunday; 2pm PDT = 21:00 UTC
      const sundayAfternoon = new Date('2026-05-24T21:00:00Z');
      expect(sundayAfternoon.getUTCDay()).toBe(0); // sanity: Sunday
      expect(isClientSequenceInQuietHours(sundayAfternoon)).toBe(false);
    });

    it('IS quiet on a Saturday at 11pm PT (hour matters, day does not)', () => {
      // 11pm PDT Saturday = 06:00 UTC Sunday
      const t = new Date('2026-05-24T06:00:00Z');
      expect(isClientSequenceInQuietHours(t)).toBe(true);
    });
  });

  describe('DST awareness (Intl handles tz; verify both halves of the year)', () => {
    it('is NOT quiet at noon PT in January (PST, UTC-8)', () => {
      // 12pm PST = 20:00 UTC
      const t = new Date('2026-01-15T20:00:00Z');
      expect(isClientSequenceInQuietHours(t)).toBe(false);
    });

    it('is quiet at 11pm PT in January (PST, UTC-8)', () => {
      // 11pm PST = 07:00 UTC next day
      const t = new Date('2026-01-16T07:00:00Z');
      expect(isClientSequenceInQuietHours(t)).toBe(true);
    });

    it('is NOT quiet at noon PT in July (PDT, UTC-7)', () => {
      const t = new Date('2026-07-15T19:00:00Z');
      expect(isClientSequenceInQuietHours(t)).toBe(false);
    });
  });
});

describe('nextClientSequenceSendTime', () => {
  it('returns the input instant unchanged when already in the active window', () => {
    const noon = new Date('2026-05-23T19:00:00Z'); // 12pm PT
    const result = nextClientSequenceSendTime(noon);
    expect(result.getTime()).toBe(noon.getTime());
  });

  it('returns a future instant when called inside quiet hours', () => {
    const elevenPm = new Date('2026-05-23T06:00:00Z'); // 11pm PT prev day
    const result = nextClientSequenceSendTime(elevenPm);
    expect(result.getTime()).toBeGreaterThan(elevenPm.getTime());
  });

  it('returns a local hour of 9 (the end of the quiet window) when deferring', () => {
    // 1am PT → next send should be 9am PT same day
    const oneAm = new Date('2026-05-23T08:00:00Z');
    const result = nextClientSequenceSendTime(oneAm);
    const localHour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: LA_TZ,
        hour: 'numeric',
        hour12: false,
      }).format(result),
      10,
    );
    expect(localHour).toBe(9);
  });

  it('defers a late-evening send to ~9am the next morning', () => {
    // 11pm PT Friday → 9am PT Saturday (~10 hours later)
    const elevenPm = new Date('2026-05-23T06:00:00Z');
    const result = nextClientSequenceSendTime(elevenPm);
    const diffHours = (result.getTime() - elevenPm.getTime()) / (60 * 60 * 1000);
    expect(diffHours).toBeGreaterThanOrEqual(9);
    expect(diffHours).toBeLessThanOrEqual(11); // 10h ± DST slack
  });

  it('defers a pre-dawn send to ~9am the same morning', () => {
    // 3am PT → 9am PT same day (~6 hours later)
    const threeAm = new Date('2026-05-23T10:00:00Z');
    const result = nextClientSequenceSendTime(threeAm);
    const diffHours = (result.getTime() - threeAm.getTime()) / (60 * 60 * 1000);
    expect(diffHours).toBeGreaterThanOrEqual(5);
    expect(diffHours).toBeLessThanOrEqual(7);
  });

  it('always returns a result inside the 48-hour safety bound', () => {
    const elevenPm = new Date('2026-05-23T06:00:00Z');
    const result = nextClientSequenceSendTime(elevenPm);
    const diff = result.getTime() - elevenPm.getTime();
    expect(diff).toBeLessThanOrEqual(48 * 60 * 60 * 1000);
  });
});
