import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REMINDER_HOURS,
  DEFAULT_MAX_REMINDERS,
  DEFAULT_START_HOUR,
  DEFAULT_END_HOUR,
  resolveReminderConditions,
  isWithinSendWindow,
  isReminderDue,
  shouldRemindSurvey,
  buildSurveyUrlFromToken,
  computeReminderExpiry,
  ruleAppliesToCaregiver,
} from '../../../supabase/functions/_shared/helpers/surveyReminders.ts';

describe('surveyReminders', () => {
  describe('resolveReminderConditions', () => {
    it('applies all defaults when conditions is null or undefined', () => {
      const r = resolveReminderConditions(null);
      expect(r.hours).toBe(DEFAULT_REMINDER_HOURS);
      expect(r.max_reminders).toBe(DEFAULT_MAX_REMINDERS);
      expect(r.start_hour).toBe(DEFAULT_START_HOUR);
      expect(r.end_hour).toBe(DEFAULT_END_HOUR);
      expect(r.tz).toBe('America/New_York');
    });

    it('honors valid overrides', () => {
      const r = resolveReminderConditions({
        hours: 12,
        max_reminders: 3,
        start_hour: 8,
        end_hour: 20,
        tz: 'America/Los_Angeles',
      });
      expect(r.hours).toBe(12);
      expect(r.max_reminders).toBe(3);
      expect(r.start_hour).toBe(8);
      expect(r.end_hour).toBe(20);
      expect(r.tz).toBe('America/Los_Angeles');
    });

    it('falls back to defaults for invalid numeric values', () => {
      const r = resolveReminderConditions({ hours: 0, max_reminders: -1, start_hour: 99, end_hour: 25 });
      expect(r.hours).toBe(DEFAULT_REMINDER_HOURS);
      expect(r.max_reminders).toBe(DEFAULT_MAX_REMINDERS);
      expect(r.start_hour).toBe(DEFAULT_START_HOUR);
      // end_hour=25 is > 24 so falls back; end_hour=24 would be allowed
      expect(r.end_hour).toBe(DEFAULT_END_HOUR);
    });

    it('allows end_hour of exactly 24 (midnight)', () => {
      const r = resolveReminderConditions({ end_hour: 24 });
      expect(r.end_hour).toBe(24);
    });
  });

  describe('isWithinSendWindow', () => {
    // 2026-04-15 14:00 UTC = 10:00 Eastern (EDT, UTC-4)
    const midday = new Date('2026-04-15T14:00:00Z');
    // 2026-04-15 03:00 UTC = 23:00 previous day Eastern (late night)
    const lateNight = new Date('2026-04-15T03:00:00Z');
    // 2026-04-15 23:00 UTC = 19:00 Eastern (after 6pm)
    const evening = new Date('2026-04-15T23:00:00Z');
    // 2026-04-15 12:30 UTC = 08:30 Eastern (before 9am)
    const earlyMorning = new Date('2026-04-15T12:30:00Z');

    it('returns true for 10am Eastern with a 9-18 window', () => {
      expect(isWithinSendWindow(midday, 'America/New_York', 9, 18)).toBe(true);
    });

    it('returns false for 11pm Eastern with a 9-18 window', () => {
      expect(isWithinSendWindow(lateNight, 'America/New_York', 9, 18)).toBe(false);
    });

    it('returns false for 7pm Eastern (end_hour is exclusive)', () => {
      expect(isWithinSendWindow(evening, 'America/New_York', 9, 18)).toBe(false);
    });

    it('returns false for 8:30am Eastern (before start)', () => {
      expect(isWithinSendWindow(earlyMorning, 'America/New_York', 9, 18)).toBe(false);
    });

    it('returns true exactly at the start hour', () => {
      // 13:00 UTC = 09:00 Eastern
      const nineAm = new Date('2026-04-15T13:00:00Z');
      expect(isWithinSendWindow(nineAm, 'America/New_York', 9, 18)).toBe(true);
    });

    it('rejects degenerate windows where start >= end', () => {
      expect(isWithinSendWindow(midday, 'America/New_York', 18, 9)).toBe(false);
      expect(isWithinSendWindow(midday, 'America/New_York', 10, 10)).toBe(false);
    });

    it('works with different timezones', () => {
      // 10am Eastern = 7am Pacific — before the 9-18 Pacific window
      expect(isWithinSendWindow(midday, 'America/Los_Angeles', 9, 18)).toBe(false);
      // 23:00 UTC = 16:00 Pacific — inside window
      expect(isWithinSendWindow(evening, 'America/Los_Angeles', 9, 18)).toBe(true);
    });

    it('falls back to UTC if the tz string is invalid', () => {
      // 14:00 UTC with UTC 9-18 → inside window
      expect(isWithinSendWindow(midday, 'Not/A_Zone', 9, 18)).toBe(true);
    });
  });

  describe('isReminderDue', () => {
    const now = new Date('2026-04-15T14:00:00Z');

    it('is due when there is no last reminder and sent_at is older than the interval', () => {
      // sent 25h ago, interval 24h → due
      const sent = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
      expect(isReminderDue(sent, null, 24, now)).toBe(true);
    });

    it('is NOT due when there is no last reminder and sent_at is within the interval', () => {
      // sent 2h ago, interval 24h → not due
      const sent = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
      expect(isReminderDue(sent, null, 24, now)).toBe(false);
    });

    it('uses lastReminderSentAt when present, ignoring sent_at', () => {
      const sent = new Date(now.getTime() - 100 * 60 * 60 * 1000).toISOString(); // ancient
      const lastReminder = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
      expect(isReminderDue(sent, lastReminder, 24, now)).toBe(false);
    });

    it('is due when lastReminderSentAt is older than the interval', () => {
      const lastReminder = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
      expect(isReminderDue(null, lastReminder, 24, now)).toBe(true);
    });

    it('applies the small tolerance so repeat cron runs do not drift', () => {
      // Exactly 24h minus 1 minute → still due because of the 2-min tolerance
      const lastReminder = new Date(now.getTime() - (24 * 60 - 1) * 60 * 1000).toISOString();
      expect(isReminderDue(null, lastReminder, 24, now)).toBe(true);
    });

    it('returns false for zero or negative intervals', () => {
      expect(isReminderDue(null, null, 0, now)).toBe(false);
      expect(isReminderDue(null, null, -5, now)).toBe(false);
    });

    it('returns true when both timestamps are null/undefined', () => {
      expect(isReminderDue(null, null, 24, now)).toBe(true);
      expect(isReminderDue(undefined, undefined, 24, now)).toBe(true);
    });
  });

  describe('shouldRemindSurvey', () => {
    const now = new Date('2026-04-15T14:00:00Z');
    const baseSurvey = {
      status: 'pending',
      reminders_stopped: false,
      reminders_sent: 1,
      sent_at: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(),
      last_reminder_sent_at: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    };

    it('returns true for a standard pending survey that is due', () => {
      expect(shouldRemindSurvey(baseSurvey, { hours: 24, max_reminders: 5 }, now)).toBe(true);
    });

    it('returns false if the survey is already qualified', () => {
      expect(
        shouldRemindSurvey({ ...baseSurvey, status: 'qualified' }, { hours: 24, max_reminders: 5 }, now)
      ).toBe(false);
    });

    it('returns false if the survey is disqualified', () => {
      expect(
        shouldRemindSurvey({ ...baseSurvey, status: 'disqualified' }, { hours: 24, max_reminders: 5 }, now)
      ).toBe(false);
    });

    it('returns false if reminders_stopped is true (per-caregiver opt-out)', () => {
      expect(
        shouldRemindSurvey({ ...baseSurvey, reminders_stopped: true }, { hours: 24, max_reminders: 5 }, now)
      ).toBe(false);
    });

    it('returns false when reminders_sent has reached the max cap', () => {
      expect(
        shouldRemindSurvey({ ...baseSurvey, reminders_sent: 5 }, { hours: 24, max_reminders: 5 }, now)
      ).toBe(false);
    });

    it('returns false when the last reminder is too recent', () => {
      const recent = {
        ...baseSurvey,
        last_reminder_sent_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      };
      expect(shouldRemindSurvey(recent, { hours: 24, max_reminders: 5 }, now)).toBe(false);
    });

    it('applies default conditions when none are provided', () => {
      expect(shouldRemindSurvey(baseSurvey, null, now)).toBe(true);
    });

    it('treats missing reminders_sent as zero', () => {
      const fresh = {
        ...baseSurvey,
        reminders_sent: null,
        last_reminder_sent_at: null,
        sent_at: new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString(),
      };
      expect(shouldRemindSurvey(fresh, { hours: 24, max_reminders: 5 }, now)).toBe(true);
    });

    it('respects a configurable 12-hour interval', () => {
      const twelveHours = {
        ...baseSurvey,
        reminders_sent: 1,
        last_reminder_sent_at: new Date(now.getTime() - 13 * 60 * 60 * 1000).toISOString(),
      };
      expect(shouldRemindSurvey(twelveHours, { hours: 12, max_reminders: 10 }, now)).toBe(true);
    });
  });

  describe('buildSurveyUrlFromToken', () => {
    it('joins base and token with a single slash', () => {
      expect(buildSurveyUrlFromToken('sv_abc123', 'https://caregiver-portal.vercel.app')).toBe(
        'https://caregiver-portal.vercel.app/survey/sv_abc123'
      );
    });

    it('strips a trailing slash on the base url', () => {
      expect(buildSurveyUrlFromToken('sv_abc123', 'https://caregiver-portal.vercel.app/')).toBe(
        'https://caregiver-portal.vercel.app/survey/sv_abc123'
      );
    });

    it('handles multiple trailing slashes', () => {
      expect(buildSurveyUrlFromToken('sv_xyz', 'https://example.com///')).toBe(
        'https://example.com/survey/sv_xyz'
      );
    });
  });

  describe('computeReminderExpiry', () => {
    const now = new Date('2026-04-15T14:00:00Z');

    it('extends a soon-to-expire survey past the next two reminder cycles', () => {
      // Original expiry 48h from creation, 30h of that already elapsed → 18h left.
      // New expiry must cover another 2×24h = 48h window from now.
      const current = new Date(now.getTime() + 18 * 60 * 60 * 1000).toISOString();
      const result = computeReminderExpiry(now, 24, current);
      const resultMs = new Date(result).getTime();
      expect(resultMs).toBe(now.getTime() + 48 * 60 * 60 * 1000);
    });

    it('extends an already-expired survey forward from now', () => {
      // The 48h window lapsed yesterday; reminder arrives anyway.
      const current = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
      const result = computeReminderExpiry(now, 24, current);
      const resultMs = new Date(result).getTime();
      expect(resultMs).toBe(now.getTime() + 48 * 60 * 60 * 1000);
    });

    it('preserves a current expiry that is already further out than the proposed one', () => {
      // Admin set a 10-day expiry manually — don't shrink it.
      const current = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString();
      const result = computeReminderExpiry(now, 24, current);
      expect(result).toBe(current);
    });

    it('falls back to the default interval when intervalHours is zero', () => {
      const result = computeReminderExpiry(now, 0, null);
      const expected = now.getTime() + DEFAULT_REMINDER_HOURS * 2 * 60 * 60 * 1000;
      expect(new Date(result).getTime()).toBe(expected);
    });

    it('handles a null current expiry by extending from now', () => {
      const result = computeReminderExpiry(now, 12, null);
      expect(new Date(result).getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
    });

    it('handles an invalid ISO string by treating it as no prior expiry', () => {
      const result = computeReminderExpiry(now, 24, 'not-a-date');
      expect(new Date(result).getTime()).toBe(now.getTime() + 48 * 60 * 60 * 1000);
    });

    it('scales with a custom reminder interval (12h → 24h window)', () => {
      const result = computeReminderExpiry(now, 12, null);
      expect(new Date(result).getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
    });

    it('returns an ISO string', () => {
      const result = computeReminderExpiry(now, 24, null);
      expect(typeof result).toBe('string');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('ruleAppliesToCaregiver', () => {
    const intakeCg = { phase_timestamps: { intake: 1 } };
    const orientationCgViaOverride = { phase_override: 'orientation', phase_timestamps: { intake: 1 } };
    const orientationCgViaTimestamps = { phase_timestamps: { orientation: 1 } };
    const archivedCg = { archived: true, phase_timestamps: { intake: 1 } };

    it('returns true when no phase filter is set (intake caregiver)', () => {
      expect(ruleAppliesToCaregiver(intakeCg, { hours: 24 })).toBe(true);
    });

    it('returns true when no phase filter is set (past-intake caregiver)', () => {
      expect(ruleAppliesToCaregiver(orientationCgViaOverride, { hours: 24 })).toBe(true);
    });

    it('returns true when phase filter matches computed phase', () => {
      expect(ruleAppliesToCaregiver(intakeCg, { phase: 'intake' })).toBe(true);
    });

    it('returns false when phase filter does not match computed phase (via override)', () => {
      expect(ruleAppliesToCaregiver(orientationCgViaOverride, { phase: 'intake' })).toBe(false);
    });

    it('returns false when phase filter does not match computed phase (via timestamps)', () => {
      expect(ruleAppliesToCaregiver(orientationCgViaTimestamps, { phase: 'intake' })).toBe(false);
    });

    it('returns false for archived caregivers regardless of phase filter', () => {
      expect(ruleAppliesToCaregiver(archivedCg, { phase: 'intake' })).toBe(false);
      expect(ruleAppliesToCaregiver(archivedCg, {})).toBe(false);
    });

    it('returns false when caregiver is null or undefined', () => {
      expect(ruleAppliesToCaregiver(null, { phase: 'intake' })).toBe(false);
      expect(ruleAppliesToCaregiver(undefined, {})).toBe(false);
    });

    it('treats empty-string phase filter as "no filter"', () => {
      // Defensive: the UI omits `phase` from conditions when "Any phase" is
      // picked, but historical rules might have `phase: ""` stored. Treat
      // that as "no filter" so old rules behave the same.
      expect(ruleAppliesToCaregiver(orientationCgViaOverride, { phase: '' })).toBe(true);
    });

    it('matches non-intake phase filter correctly', () => {
      expect(ruleAppliesToCaregiver(orientationCgViaOverride, { phase: 'orientation' })).toBe(true);
      expect(ruleAppliesToCaregiver(orientationCgViaOverride, { phase: 'verification' })).toBe(false);
    });

    it('handles caregiver with no phase signals (defaults to intake)', () => {
      // detectPhase returns 'intake' when phase_timestamps is empty.
      expect(ruleAppliesToCaregiver({}, { phase: 'intake' })).toBe(true);
      expect(ruleAppliesToCaregiver({}, { phase: 'orientation' })).toBe(false);
    });
  });
});
