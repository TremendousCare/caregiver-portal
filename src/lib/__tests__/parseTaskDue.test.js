// Unit tests for parseTaskDue / defaultTaskDue / formatTaskDueEcho.
//
// All "local hour" assertions check Date.getHours() rather than the
// underlying UTC ms so the suite is portable across timezones (CI
// runs in UTC; developers run in Pacific/Eastern/etc).

import { describe, it, expect } from 'vitest';
import { parseTaskDue, defaultTaskDue, formatTaskDueEcho } from '../parseTaskDue';

// 2026-06-15 is a Monday. Use 10am LOCAL on that day as the reference
// so "today 5pm" still resolves to the same day.
function ref(year = 2026, month = 5, day = 15, hour = 10) {
  return new Date(year, month, day, hour, 0, 0, 0);
}

describe('parseTaskDue', () => {
  it('returns null for empty / whitespace / non-string', () => {
    expect(parseTaskDue('')).toBeNull();
    expect(parseTaskDue('   ')).toBeNull();
    expect(parseTaskDue(undefined)).toBeNull();
    expect(parseTaskDue(null)).toBeNull();
    expect(parseTaskDue(42)).toBeNull();
  });

  it('returns null when chrono cannot parse', () => {
    expect(parseTaskDue('zzzasdf', ref())).toBeNull();
  });

  it('parses "tomorrow 9am" to next day at 09:00 local', () => {
    const r = parseTaskDue('tomorrow 9am', ref());
    expect(r).toBeInstanceOf(Date);
    expect(r.getDate()).toBe(16);
    expect(r.getMonth()).toBe(5);
    expect(r.getHours()).toBe(9);
    expect(r.getMinutes()).toBe(0);
  });

  it('parses "tomorrow" without a time to default-hour (17:00) local', () => {
    const r = parseTaskDue('tomorrow', ref());
    expect(r.getDate()).toBe(16);
    expect(r.getHours()).toBe(17);
  });

  it('parses "in 3 days" to ref+3d at default hour', () => {
    const r = parseTaskDue('in 3 days', ref());
    expect(r.getDate()).toBe(18);
    expect(r.getHours()).toBe(17);
  });

  it('parses "friday 2pm" to the upcoming friday at 14:00 (forwardDate)', () => {
    // ref = Monday 2026-06-15. Upcoming Friday is 2026-06-19.
    const r = parseTaskDue('friday 2pm', ref());
    expect(r.getDay()).toBe(5);          // 5 = Friday
    expect(r.getDate()).toBe(19);
    expect(r.getHours()).toBe(14);
  });

  it('parses "next monday" to the next Monday at default hour', () => {
    const r = parseTaskDue('next monday', ref());
    expect(r.getDay()).toBe(1);          // 1 = Monday
    expect(r.getHours()).toBe(17);
    // "Next Monday" — chrono interprets as 7+ days out from a Monday ref.
    // Accept anything strictly later than ref.
    expect(r.getTime()).toBeGreaterThan(ref().getTime());
  });

  it('parses an explicit ISO-ish form like "june 30 4pm"', () => {
    const r = parseTaskDue('june 30 4pm', ref());
    expect(r.getMonth()).toBe(5);        // June
    expect(r.getDate()).toBe(30);
    expect(r.getHours()).toBe(16);
  });
});

describe('defaultTaskDue', () => {
  it('returns today at 17:00 local when ref is before 17:00', () => {
    const r = defaultTaskDue(ref(2026, 5, 15, 10));
    expect(r.getDate()).toBe(15);
    expect(r.getHours()).toBe(17);
  });

  it('returns tomorrow at 17:00 local when ref is at/after 17:00', () => {
    const r = defaultTaskDue(ref(2026, 5, 15, 17));
    expect(r.getDate()).toBe(16);
    expect(r.getHours()).toBe(17);
  });

  it('uses real now() when ref is invalid', () => {
    const r = defaultTaskDue('not-a-date');
    expect(r).toBeInstanceOf(Date);
    expect(r.getHours()).toBe(17);
  });
});

describe('formatTaskDueEcho', () => {
  it('returns "" for invalid input', () => {
    expect(formatTaskDueEcho(null)).toBe('');
    expect(formatTaskDueEcho('not-a-date')).toBe('');
    expect(formatTaskDueEcho(new Date('bogus'))).toBe('');
  });

  it('renders a non-empty string for a valid Date', () => {
    const out = formatTaskDueEcho(new Date(2026, 5, 16, 9, 0));
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    // Should contain "·" separator between date and time parts.
    expect(out).toContain('·');
  });
});
