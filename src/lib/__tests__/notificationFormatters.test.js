// Tests for the in-portal notification bell + dropdown formatters
// (PR 4 of the lead-notif feature).

import { describe, it, expect } from 'vitest';
import {
  formatNotificationTimeAgo,
  composeNotificationToast,
} from '../notificationFormatters';

describe('formatNotificationTimeAgo', () => {
  const now = new Date('2026-05-23T15:00:00Z');

  it('returns empty string for null / undefined', () => {
    expect(formatNotificationTimeAgo(null, now)).toBe('');
    expect(formatNotificationTimeAgo(undefined, now)).toBe('');
  });

  it('returns empty string for an unparseable timestamp', () => {
    expect(formatNotificationTimeAgo('not-a-date', now)).toBe('');
  });

  it('returns "just now" for timestamps under a minute old', () => {
    const t = new Date(now.getTime() - 30 * 1000).toISOString();
    expect(formatNotificationTimeAgo(t, now)).toBe('just now');
  });

  it('returns "just now" for future timestamps (clock skew defensive)', () => {
    const t = new Date(now.getTime() + 30 * 1000).toISOString();
    expect(formatNotificationTimeAgo(t, now)).toBe('just now');
  });

  it('returns "Nm ago" for under an hour', () => {
    const t = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    expect(formatNotificationTimeAgo(t, now)).toBe('5m ago');
  });

  it('returns "Nh ago" for under a day', () => {
    const t = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatNotificationTimeAgo(t, now)).toBe('3h ago');
  });

  it('returns "yesterday" for exactly 1 day ago', () => {
    const t = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(formatNotificationTimeAgo(t, now)).toBe('yesterday');
  });

  it('returns "Nd ago" for older timestamps', () => {
    const t = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatNotificationTimeAgo(t, now)).toBe('5d ago');
  });
});

describe('composeNotificationToast', () => {
  it('returns "title: message" when both are present', () => {
    const row = { title: 'New lead in pipeline', message: 'Jane Doe' };
    expect(composeNotificationToast(row)).toBe('New lead in pipeline: Jane Doe');
  });

  it('returns title alone when message is missing', () => {
    const row = { title: 'Reminder', message: '' };
    expect(composeNotificationToast(row)).toBe('Reminder');
  });

  it('returns message alone when title is missing', () => {
    const row = { title: '', message: 'Something happened' };
    expect(composeNotificationToast(row)).toBe('Something happened');
  });

  it('returns the fallback string when both are blank', () => {
    expect(composeNotificationToast({ title: '', message: '' })).toBe('New notification');
  });

  it('returns the fallback string for null input', () => {
    expect(composeNotificationToast(null)).toBe('New notification');
  });

  it('trims whitespace from title and message', () => {
    expect(composeNotificationToast({ title: '  Hi  ', message: '  there  ' }))
      .toBe('Hi: there');
  });

  it('ignores non-string fields gracefully', () => {
    expect(composeNotificationToast({ title: 42, message: null }))
      .toBe('New notification');
  });
});
