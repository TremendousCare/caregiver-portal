import { describe, it, expect } from 'vitest';
import { effectiveShiftStatus, nextClockAction, hasPendingEvent } from '../pendingStatus';

describe('effectiveShiftStatus', () => {
  it('returns the DB status when nothing is queued', () => {
    expect(effectiveShiftStatus('assigned', [])).toBe('assigned');
    expect(effectiveShiftStatus('in_progress')).toBe('in_progress');
  });

  it('advances to in_progress with a queued clock-in', () => {
    expect(effectiveShiftStatus('assigned', [{ eventType: 'in', createdAt: 1 }])).toBe('in_progress');
    expect(effectiveShiftStatus('confirmed', [{ eventType: 'in', createdAt: 1 }])).toBe('in_progress');
  });

  it('advances to completed with queued in then out', () => {
    const pending = [
      { eventType: 'out', createdAt: 2 },
      { eventType: 'in', createdAt: 1 },
    ];
    expect(effectiveShiftStatus('assigned', pending)).toBe('completed');
  });

  it('ignores a clock-out that has no preceding in_progress', () => {
    expect(effectiveShiftStatus('assigned', [{ eventType: 'out', createdAt: 1 }])).toBe('assigned');
  });
});

describe('nextClockAction', () => {
  it('maps status to the available action', () => {
    expect(nextClockAction('assigned')).toBe('in');
    expect(nextClockAction('confirmed')).toBe('in');
    expect(nextClockAction('in_progress')).toBe('out');
    expect(nextClockAction('completed')).toBeNull();
    expect(nextClockAction('cancelled')).toBeNull();
  });
});

describe('hasPendingEvent', () => {
  it('detects a queued event of a given type', () => {
    const pending = [{ eventType: 'in', status: 'pending' }];
    expect(hasPendingEvent(pending, 'in')).toBe(true);
    expect(hasPendingEvent(pending, 'out')).toBe(false);
  });

  it('ignores failed entries', () => {
    const pending = [{ eventType: 'in', status: 'failed' }];
    expect(hasPendingEvent(pending, 'in')).toBe(false);
  });
});
