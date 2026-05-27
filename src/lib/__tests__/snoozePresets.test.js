// Unit tests for snooze preset helpers. Each preset is pure given a
// `now` argument — these tests pin behavior across timezones by
// checking local hour / day arithmetic rather than UTC instants.

import { describe, it, expect } from 'vitest';
import {
  snoozeOneHour,
  snoozeTonight,
  snoozeTomorrowMorning,
  snoozeNextMondayMorning,
  SNOOZE_PRESETS,
} from '../snoozePresets';

// Helpers — construct a local-time anchor regardless of CI TZ.
function localAt(year, month, day, hour) {
  return new Date(year, month, day, hour, 0, 0, 0);
}

describe('snoozeOneHour', () => {
  it('adds exactly one hour', () => {
    const now = localAt(2026, 5, 15, 10);
    const out = snoozeOneHour(now);
    expect(out.getTime() - now.getTime()).toBe(60 * 60 * 1000);
  });
});

describe('snoozeTonight', () => {
  it('returns today at 18:00 local when ref is before 6pm', () => {
    const now = localAt(2026, 5, 15, 10);
    const out = snoozeTonight(now);
    expect(out.getDate()).toBe(15);
    expect(out.getHours()).toBe(18);
    expect(out.getMinutes()).toBe(0);
  });

  it('rolls to tomorrow 09:00 when ref is at/after 6pm', () => {
    const now = localAt(2026, 5, 15, 19);
    const out = snoozeTonight(now);
    expect(out.getDate()).toBe(16);
    expect(out.getHours()).toBe(9);
  });

  it('rolls to tomorrow 09:00 when ref is exactly 6pm (no zero-snooze)', () => {
    const now = localAt(2026, 5, 15, 18);
    const out = snoozeTonight(now);
    expect(out.getDate()).toBe(16);
    expect(out.getHours()).toBe(9);
  });
});

describe('snoozeTomorrowMorning', () => {
  it('returns the next day at 09:00 local', () => {
    const now = localAt(2026, 5, 15, 22); // 10pm Mon Jun 15
    const out = snoozeTomorrowMorning(now);
    expect(out.getDate()).toBe(16);
    expect(out.getMonth()).toBe(5);
    expect(out.getHours()).toBe(9);
  });

  it('handles month roll-over', () => {
    const now = localAt(2026, 5, 30, 10); // Tue Jun 30
    const out = snoozeTomorrowMorning(now);
    expect(out.getMonth()).toBe(6); // July
    expect(out.getDate()).toBe(1);
    expect(out.getHours()).toBe(9);
  });
});

describe('snoozeNextMondayMorning', () => {
  // 2026-06-15 is a Monday. 2026-06-16 is Tuesday, etc.
  it('on a Monday, returns the next Monday (+7d) at 09:00', () => {
    const monday = localAt(2026, 5, 15, 14);
    const out = snoozeNextMondayMorning(monday);
    expect(out.getDay()).toBe(1);
    expect(out.getDate()).toBe(22);
    expect(out.getHours()).toBe(9);
  });

  it('on a Tuesday, returns the next Monday (6 days later)', () => {
    const tuesday = localAt(2026, 5, 16, 10);
    const out = snoozeNextMondayMorning(tuesday);
    expect(out.getDay()).toBe(1);
    expect(out.getDate()).toBe(22);
  });

  it('on a Friday, returns the next Monday (3 days later)', () => {
    const friday = localAt(2026, 5, 19, 10);
    const out = snoozeNextMondayMorning(friday);
    expect(out.getDay()).toBe(1);
    expect(out.getDate()).toBe(22);
  });

  it('on a Sunday, returns Monday (the next day)', () => {
    const sunday = localAt(2026, 5, 14, 10); // Sun Jun 14
    const out = snoozeNextMondayMorning(sunday);
    expect(out.getDay()).toBe(1);
    expect(out.getDate()).toBe(15);
  });
});

describe('SNOOZE_PRESETS', () => {
  it('exposes the four expected presets in display order', () => {
    expect(SNOOZE_PRESETS.map((p) => p.id)).toEqual([
      '1h', 'tonight', 'tomorrow', 'monday',
    ]);
  });

  it('every preset has label + compute', () => {
    for (const p of SNOOZE_PRESETS) {
      expect(typeof p.label).toBe('string');
      expect(p.label.length).toBeGreaterThan(0);
      expect(typeof p.compute).toBe('function');
      expect(p.compute(new Date())).toBeInstanceOf(Date);
    }
  });

  it('every preset compute returns a future date', () => {
    const now = localAt(2026, 5, 15, 10);
    for (const p of SNOOZE_PRESETS) {
      const out = p.compute(now);
      expect(out.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
