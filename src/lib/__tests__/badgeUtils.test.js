import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDueDateBadge, getHcaBadge } from '../badgeUtils';

// Fix "today" to 2026-03-18 for deterministic tests
const FIXED_NOW = new Date('2026-03-18T12:00:00');

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('getDueDateBadge', () => {
  it('returns null for no due date', () => {
    expect(getDueDateBadge(null)).toBeNull();
    expect(getDueDateBadge(undefined)).toBeNull();
  });

  it('returns overdue badge for past dates', () => {
    const badge = getDueDateBadge('2026-03-15');
    expect(badge.label).toContain('overdue');
    expect(badge.color).toBe('#DC3545');
  });

  it('returns today badge for today', () => {
    const badge = getDueDateBadge('2026-03-18');
    expect(badge.label).toContain('today');
    expect(badge.color).toBe('#D97706');
  });

  it('returns amber badge for 1-3 days out', () => {
    const badge = getDueDateBadge('2026-03-20');
    expect(badge.label).toContain('2d');
    expect(badge.color).toBe('#D97706');
  });

  it('returns neutral badge for 4+ days out', () => {
    const badge = getDueDateBadge('2026-03-25');
    expect(badge.label).toBe('Mar 25');
    expect(badge.color).toBe('#556270');
  });
});

describe('getHcaBadge', () => {
  it('returns null for no HCA date', () => {
    expect(getHcaBadge(null)).toBeNull();
    expect(getHcaBadge(undefined)).toBeNull();
  });

  it('returns expired badge for past dates', () => {
    const badge = getHcaBadge('2026-03-10');
    expect(badge.label).toBe('HCA Expired');
    expect(badge.color).toBe('#DC3545');
  });

  it('returns amber badge for <30 days', () => {
    const badge = getHcaBadge('2026-04-10');
    expect(badge.label).toMatch(/^HCA \d+d$/);
    expect(badge.color).toBe('#D97706');
  });

  it('returns null for 30+ days out', () => {
    expect(getHcaBadge('2026-06-01')).toBeNull();
  });
});
