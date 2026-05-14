/**
 * Tests for the interview_reminder helpers in bookings.ts.
 *
 * The reminder cron has three pure decisions:
 *   1. parseInterviewReminderMinutes — turn user input (number, array,
 *      "15, 60") into a clean sorted list of positive integers.
 *   2. isInReminderWindow — does the interview's start_at fall inside the
 *      "fire now" window for a given lead time?
 *   3. computeInterviewReminderLookaheadMs — how far ahead does the cron
 *      need to look so it never misses a window?
 *
 * Plus an eligibility predicate on interview status, and a TZ-aware time
 * formatter for {{interview_start_text}}. All of these have to be locked
 * down so a future refactor can't quietly change the firing semantics —
 * a one-minute drift here means a 15-min reminder lands 16 min before
 * or after, which is the difference between "useful" and "annoying".
 */

import { describe, it, expect } from 'vitest';
import {
  parseInterviewReminderMinutes,
  isInReminderWindow,
  computeInterviewReminderLookaheadMs,
  formatInterviewStartText,
  isInterviewStatusReminderEligible,
  INTERVIEW_REMINDER_WINDOW_MS,
  INTERVIEW_REMINDER_ACTIVE_STATUSES,
} from '../../../supabase/functions/_shared/helpers/bookings.ts';

describe('parseInterviewReminderMinutes', () => {
  it('accepts a single number', () => {
    expect(parseInterviewReminderMinutes(15)).toEqual([15]);
  });

  it('accepts an array of numbers and sorts descending', () => {
    expect(parseInterviewReminderMinutes([15, 60, 1440])).toEqual([1440, 60, 15]);
  });

  it('accepts a comma-separated string', () => {
    expect(parseInterviewReminderMinutes('15, 60')).toEqual([60, 15]);
  });

  it('dedups duplicates', () => {
    expect(parseInterviewReminderMinutes([15, 15, 15])).toEqual([15]);
    expect(parseInterviewReminderMinutes('15,15,60')).toEqual([60, 15]);
  });

  it('rejects zero, negative, and non-integer values', () => {
    expect(parseInterviewReminderMinutes(0)).toEqual([]);
    expect(parseInterviewReminderMinutes(-5)).toEqual([]);
    expect(parseInterviewReminderMinutes(15.5)).toEqual([]);
    expect(parseInterviewReminderMinutes('-5')).toEqual([]);
    expect(parseInterviewReminderMinutes('0')).toEqual([]);
    expect(parseInterviewReminderMinutes('abc')).toEqual([]);
  });

  it('handles mixed valid/invalid in a string', () => {
    expect(parseInterviewReminderMinutes('15, abc, 60, -5')).toEqual([60, 15]);
  });

  it('returns [] for null, undefined, empty string, empty array', () => {
    expect(parseInterviewReminderMinutes(null)).toEqual([]);
    expect(parseInterviewReminderMinutes(undefined)).toEqual([]);
    expect(parseInterviewReminderMinutes('')).toEqual([]);
    expect(parseInterviewReminderMinutes([])).toEqual([]);
  });
});

describe('isInReminderWindow', () => {
  // Pinned "now" for deterministic math: 2026-05-14T14:00:00Z.
  const NOW = Date.parse('2026-05-14T14:00:00Z');

  it('fires at the exact lead-time target', () => {
    // Interview at 14:15, lead time 15 min → target 14:00 → now=14:00 → fire.
    const startAt = new Date(NOW + 15 * 60 * 1000).toISOString();
    expect(isInReminderWindow({ startAt, minutesBefore: 15, now: NOW })).toBe(true);
  });

  it('fires within the 5-minute window past the target', () => {
    // Interview at 14:18, lead time 15 min → target 14:03 → 3 min past at 14:00? No.
    // Re-think: interview at NOW + 12 min, target = NOW + 12 - 15 = NOW - 3 min.
    // Now is 3 min past target → still inside the 5-min window.
    const startAt = new Date(NOW + 12 * 60 * 1000).toISOString();
    expect(isInReminderWindow({ startAt, minutesBefore: 15, now: NOW })).toBe(true);
  });

  it('does NOT fire before the target lead time', () => {
    // Interview at 14:20, target 14:05. Now is 14:00 → 5 min before target → skip.
    const startAt = new Date(NOW + 20 * 60 * 1000).toISOString();
    expect(isInReminderWindow({ startAt, minutesBefore: 15, now: NOW })).toBe(false);
  });

  it('does NOT fire after the window has fully passed', () => {
    // Interview at 14:09, target 13:54. Now is 14:00 → 6 min past target →
    // outside the 5-min window. The previous cron tick should have caught it.
    const startAt = new Date(NOW + 9 * 60 * 1000).toISOString();
    expect(isInReminderWindow({ startAt, minutesBefore: 15, now: NOW })).toBe(false);
  });

  it('handles different lead times (1h, 24h)', () => {
    // 1-hour reminder: interview at NOW + 60 min, target NOW. Fire.
    const oneHourLater = new Date(NOW + 60 * 60 * 1000).toISOString();
    expect(isInReminderWindow({ startAt: oneHourLater, minutesBefore: 60, now: NOW })).toBe(true);

    // 24-hour reminder: interview at NOW + 1440 min, target NOW. Fire.
    const oneDayLater = new Date(NOW + 1440 * 60 * 1000).toISOString();
    expect(isInReminderWindow({ startAt: oneDayLater, minutesBefore: 1440, now: NOW })).toBe(true);

    // 24-hour reminder: interview at NOW + 1430 min, target NOW - 10 min → outside.
    const tooLate = new Date(NOW + 1430 * 60 * 1000).toISOString();
    expect(isInReminderWindow({ startAt: tooLate, minutesBefore: 1440, now: NOW })).toBe(false);
  });

  it('returns false on missing or invalid start_at', () => {
    expect(isInReminderWindow({ startAt: null, minutesBefore: 15, now: NOW })).toBe(false);
    expect(isInReminderWindow({ startAt: undefined, minutesBefore: 15, now: NOW })).toBe(false);
    expect(isInReminderWindow({ startAt: 'not-a-date', minutesBefore: 15, now: NOW })).toBe(false);
  });

  it('returns false on invalid minutesBefore', () => {
    const startAt = new Date(NOW + 15 * 60 * 1000).toISOString();
    expect(isInReminderWindow({ startAt, minutesBefore: 0, now: NOW })).toBe(false);
    expect(isInReminderWindow({ startAt, minutesBefore: -5, now: NOW })).toBe(false);
  });

  it('respects a custom windowMs override', () => {
    // 10-min window: an interview 6 min past the target now fires.
    const startAt = new Date(NOW + 9 * 60 * 1000).toISOString();
    expect(
      isInReminderWindow({ startAt, minutesBefore: 15, now: NOW, windowMs: 10 * 60 * 1000 }),
    ).toBe(true);
  });
});

describe('computeInterviewReminderLookaheadMs', () => {
  it('returns the max lead time plus one window for a single value', () => {
    const ms = computeInterviewReminderLookaheadMs([15]);
    expect(ms).toBe(15 * 60 * 1000 + INTERVIEW_REMINDER_WINDOW_MS);
  });

  it('uses the maximum lead time when multiple are configured', () => {
    const ms = computeInterviewReminderLookaheadMs([15, 60, 1440]);
    expect(ms).toBe(1440 * 60 * 1000 + INTERVIEW_REMINDER_WINDOW_MS);
  });

  it('returns 0 for an empty list', () => {
    expect(computeInterviewReminderLookaheadMs([])).toBe(0);
  });
});

describe('formatInterviewStartText', () => {
  it('formats a timestamp in the requested timezone', () => {
    // 2026-05-14T18:30:00Z = 2:30 PM EDT (UTC-4 in May).
    const text = formatInterviewStartText('2026-05-14T18:30:00Z', 'America/New_York');
    expect(text).toMatch(/Thu/);
    expect(text).toMatch(/May/);
    expect(text).toMatch(/14/);
    expect(text).toMatch(/2:30/);
    // Contains EDT or EST (TZ abbreviation).
    expect(text).toMatch(/E[DS]T/);
  });

  it('returns empty string on missing input', () => {
    expect(formatInterviewStartText(null)).toBe('');
    expect(formatInterviewStartText(undefined)).toBe('');
    expect(formatInterviewStartText('')).toBe('');
  });

  it('returns empty string on unparseable input', () => {
    expect(formatInterviewStartText('not-a-date')).toBe('');
  });
});

describe('isInterviewStatusReminderEligible', () => {
  it('accepts booked and rescheduled', () => {
    expect(isInterviewStatusReminderEligible('booked')).toBe(true);
    expect(isInterviewStatusReminderEligible('rescheduled')).toBe(true);
  });

  it('rejects cancelled, completed, no_show, null', () => {
    expect(isInterviewStatusReminderEligible('cancelled')).toBe(false);
    expect(isInterviewStatusReminderEligible('completed')).toBe(false);
    expect(isInterviewStatusReminderEligible('no_show')).toBe(false);
    expect(isInterviewStatusReminderEligible(null)).toBe(false);
    expect(isInterviewStatusReminderEligible(undefined)).toBe(false);
    expect(isInterviewStatusReminderEligible('')).toBe(false);
  });

  it('exports a list of active statuses that matches the predicate', () => {
    for (const status of INTERVIEW_REMINDER_ACTIVE_STATUSES) {
      expect(isInterviewStatusReminderEligible(status)).toBe(true);
    }
  });
});
