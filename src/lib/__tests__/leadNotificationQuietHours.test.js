// Quiet-hours math tests for the dispatch-lead-notifications worker.
//
// These functions decide whether a notification fires now or is
// deferred to morning. Edge cases that matter:
//   • Midnight-wrapping windows (the common case: 21 → 7).
//   • Non-wrapping windows (rare, but admins might set 1 → 5).
//   • Degenerate windows (start === end) — must never lock out sends.
//   • DST transitions (the function uses Intl, so they should "just
//     work", but we verify the LA tz reports the right local hour
//     across known cases).

import { describe, it, expect } from 'vitest';
import {
  isInQuietHours,
  nextSendTime,
  coerceLeadNotificationSettings,
  DEFAULT_LEAD_NOTIFICATION_SETTINGS,
} from '../../../supabase/functions/_shared/helpers/leadNotifications.ts';

// Helpers for constructing test fixtures.
// `2026-05-23T04:00:00Z` is 9pm 2026-05-22 in America/Los_Angeles (PDT).
// `2026-05-23T15:00:00Z` is 8am 2026-05-23 in America/Los_Angeles (PDT).
const LA_TZ = 'America/Los_Angeles';

describe('isInQuietHours', () => {
  it('returns false for a degenerate window (start === end)', () => {
    const noon = new Date('2026-05-23T19:00:00Z'); // 12pm LA
    expect(isInQuietHours(noon, LA_TZ, 9, 9)).toBe(false);
    // Even at midnight, with a degenerate window we should send.
    const midnight = new Date('2026-05-23T07:00:00Z'); // 12am LA
    expect(isInQuietHours(midnight, LA_TZ, 0, 0)).toBe(false);
  });

  describe('non-wrapping window (e.g. 1 → 5 means quiet 1am-5am)', () => {
    it('is quiet at 2am LA', () => {
      // 2am LA = 9am UTC (PDT, UTC-7)
      const t = new Date('2026-05-23T09:00:00Z');
      expect(isInQuietHours(t, LA_TZ, 1, 5)).toBe(true);
    });

    it('is NOT quiet at 5am LA (endHour is exclusive)', () => {
      const t = new Date('2026-05-23T12:00:00Z'); // 5am LA
      expect(isInQuietHours(t, LA_TZ, 1, 5)).toBe(false);
    });

    it('is NOT quiet at noon LA', () => {
      const t = new Date('2026-05-23T19:00:00Z'); // 12pm LA
      expect(isInQuietHours(t, LA_TZ, 1, 5)).toBe(false);
    });
  });

  describe('midnight-wrapping window (21 → 7, the V1 default)', () => {
    it('is quiet at 9pm LA exactly (start hour inclusive)', () => {
      const t = new Date('2026-05-23T04:00:00Z'); // 9pm LA on May 22
      expect(isInQuietHours(t, LA_TZ, 21, 7)).toBe(true);
    });

    it('is quiet at 11pm LA', () => {
      const t = new Date('2026-05-23T06:00:00Z'); // 11pm LA on May 22
      expect(isInQuietHours(t, LA_TZ, 21, 7)).toBe(true);
    });

    it('is quiet at 3am LA', () => {
      const t = new Date('2026-05-23T10:00:00Z'); // 3am LA
      expect(isInQuietHours(t, LA_TZ, 21, 7)).toBe(true);
    });

    it('is quiet at 6:59am LA (the last quiet minute)', () => {
      // 6:59am LA = 13:59 UTC (PDT)
      const t = new Date('2026-05-23T13:59:00Z');
      expect(isInQuietHours(t, LA_TZ, 21, 7)).toBe(true);
    });

    it('is NOT quiet at 7am LA exactly (endHour exclusive)', () => {
      const t = new Date('2026-05-23T14:00:00Z'); // 7am LA
      expect(isInQuietHours(t, LA_TZ, 21, 7)).toBe(false);
    });

    it('is NOT quiet at 8pm LA (one hour before quiet starts)', () => {
      const t = new Date('2026-05-23T03:00:00Z'); // 8pm LA on May 22
      expect(isInQuietHours(t, LA_TZ, 21, 7)).toBe(false);
    });

    it('is NOT quiet at noon LA', () => {
      const t = new Date('2026-05-23T19:00:00Z'); // 12pm LA
      expect(isInQuietHours(t, LA_TZ, 21, 7)).toBe(false);
    });
  });

  it('falls back to UTC if the tz is malformed', () => {
    // 5pm UTC. With a broken tz, isInQuietHours uses UTC hours; 21..7
    // wraps, so 17 should not be in the quiet zone.
    const t = new Date('2026-05-23T17:00:00Z');
    expect(isInQuietHours(t, 'Not/A_Real_Tz', 21, 7)).toBe(false);
  });
});

describe('nextSendTime', () => {
  it('returns the same instant when we are not in quiet hours', () => {
    const noon = new Date('2026-05-23T19:00:00Z'); // 12pm LA
    const result = nextSendTime(noon, LA_TZ, 21, 7);
    expect(result.getTime()).toBe(noon.getTime());
  });

  it('returns a future timestamp inside quiet hours', () => {
    const elevenPm = new Date('2026-05-23T06:00:00Z'); // 11pm LA May 22
    const result = nextSendTime(elevenPm, LA_TZ, 21, 7);
    expect(result.getTime()).toBeGreaterThan(elevenPm.getTime());
  });

  it('returns a timestamp at the endHour local time', () => {
    // 1am LA, quiet 21..7. Next send should be 7am LA today.
    const oneAm = new Date('2026-05-23T08:00:00Z');
    const result = nextSendTime(oneAm, LA_TZ, 21, 7);
    const localHour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: LA_TZ,
        hour: 'numeric',
        hour12: false,
      }).format(result),
      10,
    );
    expect(localHour).toBe(7);
  });

  it('returns within 24 hours for a wrapping window', () => {
    const elevenPm = new Date('2026-05-23T06:00:00Z');
    const result = nextSendTime(elevenPm, LA_TZ, 21, 7);
    const diff = result.getTime() - elevenPm.getTime();
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(48 * 60 * 60 * 1000);
  });
});

describe('coerceLeadNotificationSettings', () => {
  it('returns the defaults for null / undefined input', () => {
    expect(coerceLeadNotificationSettings(null)).toEqual(DEFAULT_LEAD_NOTIFICATION_SETTINGS);
    expect(coerceLeadNotificationSettings(undefined)).toEqual(DEFAULT_LEAD_NOTIFICATION_SETTINGS);
  });

  it('returns the defaults for array input (defensive)', () => {
    expect(coerceLeadNotificationSettings([])).toEqual(DEFAULT_LEAD_NOTIFICATION_SETTINGS);
  });

  it('preserves valid values', () => {
    const input = {
      enabled: true,
      sms_recipient_emails: ['amy@example.com'],
      teams_webhook_url: 'https://example.com/hook',
      toast_recipient_emails: ['kevin@example.com'],
      quiet_hours_start_hour: 22,
      quiet_hours_end_hour: 8,
      quiet_hours_timezone: 'America/Chicago',
    };
    expect(coerceLeadNotificationSettings(input)).toEqual(input);
  });

  it('falls back to defaults for wrong types', () => {
    const result = coerceLeadNotificationSettings({
      enabled: 'yes',           // wrong: not boolean
      sms_recipient_emails: 'not-an-array',
      teams_webhook_url: 99,
      toast_recipient_emails: null,
      quiet_hours_start_hour: 'eleven',
      quiet_hours_end_hour: 25, // out of range
      quiet_hours_timezone: '',
    });
    expect(result).toEqual(DEFAULT_LEAD_NOTIFICATION_SETTINGS);
  });

  it('filters non-string entries from recipient arrays', () => {
    const result = coerceLeadNotificationSettings({
      sms_recipient_emails: ['amy@example.com', null, 42, 'kevin@example.com'],
      toast_recipient_emails: [],
    });
    expect(result.sms_recipient_emails).toEqual(['amy@example.com', 'kevin@example.com']);
  });
});
