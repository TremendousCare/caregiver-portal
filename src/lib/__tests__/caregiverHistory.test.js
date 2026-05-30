import { describe, it, expect } from 'vitest';
import { isPastShift, groupShiftsByDay } from '../caregiverHistory';

describe('isPastShift', () => {
  const now = new Date('2026-05-30T12:00:00Z');
  it('is true when the shift has ended', () => {
    expect(isPastShift({ end_time: '2026-05-30T10:00:00Z' }, now)).toBe(true);
  });
  it('is false when the shift ends in the future', () => {
    expect(isPastShift({ end_time: '2026-05-30T14:00:00Z' }, now)).toBe(false);
  });
  it('is false for an invalid/missing end_time', () => {
    expect(isPastShift({}, now)).toBe(false);
    expect(isPastShift({ end_time: 'nope' }, now)).toBe(false);
  });
});

describe('groupShiftsByDay', () => {
  it('buckets shifts by local calendar day, newest day first', () => {
    const shifts = [
      { id: 'a', start_time: '2026-05-28T09:00:00' },
      { id: 'b', start_time: '2026-05-30T09:00:00' },
      { id: 'c', start_time: '2026-05-30T14:00:00' },
    ];
    const groups = groupShiftsByDay(shifts);
    expect(groups).toHaveLength(2);
    // newest day (the 30th) first
    expect(groups[0].shifts.map((s) => s.id)).toEqual(['c', 'b']); // newest shift first within day
    expect(groups[1].shifts.map((s) => s.id)).toEqual(['a']);
  });

  it('skips shifts with invalid start_time and handles empty input', () => {
    expect(groupShiftsByDay([])).toEqual([]);
    expect(groupShiftsByDay([{ id: 'x', start_time: 'bad' }])).toEqual([]);
  });
});
