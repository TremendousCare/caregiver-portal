import { describe, it, expect } from 'vitest';
import {
  evaluateShiftWindow,
  CLOCK_IN_GRACE_BEFORE_MIN,
  CLOCK_OUT_GRACE_AFTER_MIN,
} from '../shiftWindow';

const SHIFT_START = '2026-04-25T14:00:00Z';
const SHIFT_END = '2026-04-25T18:00:00Z';

function offsetMin(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

describe('evaluateShiftWindow — clock in', () => {
  it('passes exactly at scheduled start', () => {
    const r = evaluateShiftWindow({
      now: SHIFT_START, startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'in',
    });
    expect(r.passed).toBe(true);
  });

  it('passes 10 minutes early (within grace)', () => {
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_START, -10),
      startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'in',
    });
    expect(r.passed).toBe(true);
  });

  it('passes at the very edge of the early-grace window', () => {
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_START, -CLOCK_IN_GRACE_BEFORE_MIN),
      startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'in',
    });
    expect(r.passed).toBe(true);
  });

  it('fails when more than the grace window early', () => {
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_START, -(CLOCK_IN_GRACE_BEFORE_MIN + 5)),
      startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'in',
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('too_early');
    expect(r.minutesEarly).toBe(5);
  });

  it('fails when clocking in 6 hours before shift (the original bug)', () => {
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_START, -360),
      startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'in',
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('too_early');
    expect(r.minutesEarly).toBe(360 - CLOCK_IN_GRACE_BEFORE_MIN);
  });

  it('passes mid-shift', () => {
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_START, 60),
      startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'in',
    });
    expect(r.passed).toBe(true);
  });

  it('passes exactly at scheduled end', () => {
    const r = evaluateShiftWindow({
      now: SHIFT_END, startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'in',
    });
    expect(r.passed).toBe(true);
  });

  it('fails after the shift has ended', () => {
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_END, 5),
      startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'in',
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('too_late');
    expect(r.minutesLate).toBe(5);
  });
});

describe('evaluateShiftWindow — clock out', () => {
  it('passes exactly at scheduled end', () => {
    const r = evaluateShiftWindow({
      now: SHIFT_END, startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'out',
    });
    expect(r.passed).toBe(true);
  });

  it('passes 30 minutes late', () => {
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_END, 30),
      startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'out',
    });
    expect(r.passed).toBe(true);
  });

  it('passes at the very edge of the late-grace window', () => {
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_END, CLOCK_OUT_GRACE_AFTER_MIN),
      startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'out',
    });
    expect(r.passed).toBe(true);
  });

  it('fails when more than the grace window late', () => {
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_END, CLOCK_OUT_GRACE_AFTER_MIN + 15),
      startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'out',
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('too_late');
    expect(r.minutesLate).toBe(15);
  });

  it('passes mid-shift (caregiver leaves early)', () => {
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_START, 30),
      startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'out',
    });
    expect(r.passed).toBe(true);
  });

  it('fails when clocking out before shift even started', () => {
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_START, -5),
      startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'out',
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('too_early');
    expect(r.minutesEarly).toBe(5);
  });
});

describe('evaluateShiftWindow — invalid inputs', () => {
  it('fails on non-parsable times', () => {
    const r = evaluateShiftWindow({
      now: 'not-a-date', startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'in',
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('invalid_time');
  });

  it('fails on missing endTime', () => {
    const r = evaluateShiftWindow({
      now: SHIFT_START, startTime: SHIFT_START, endTime: null, eventType: 'in',
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('invalid_time');
  });

  it('fails on unknown event type', () => {
    const r = evaluateShiftWindow({
      now: SHIFT_START, startTime: SHIFT_START, endTime: SHIFT_END, eventType: 'pause',
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('invalid_event_type');
  });

  it('accepts Date objects as well as ISO strings', () => {
    const r = evaluateShiftWindow({
      now: new Date(SHIFT_START),
      startTime: new Date(SHIFT_START),
      endTime: new Date(SHIFT_END),
      eventType: 'in',
    });
    expect(r.passed).toBe(true);
  });

  it('honors custom grace overrides', () => {
    // 30 min early, custom grace of 45 min — should pass
    const r = evaluateShiftWindow({
      now: offsetMin(SHIFT_START, -30),
      startTime: SHIFT_START, endTime: SHIFT_END,
      eventType: 'in',
      graceBeforeMin: 45,
    });
    expect(r.passed).toBe(true);
  });
});
