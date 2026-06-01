import { describe, it, expect } from 'vitest';
import {
  PERIOD_OPTIONS,
  DEFAULT_PERIOD,
  resolvePeriod,
  dayOffset,
  addDays,
  monthOf,
} from '../financialsPeriods.js';

// Fixed reference: Thursday, 14 May 2026.
const NOW = new Date('2026-05-14T18:00:00.000Z');

describe('period options', () => {
  it('exposes the four selectable periods and defaults to MTD', () => {
    expect(PERIOD_OPTIONS.map((o) => o.id)).toEqual(['mtd', 'qtd', 'ytd', 't12m']);
    expect(DEFAULT_PERIOD).toBe('mtd');
  });
});

describe('resolvePeriod — month to date', () => {
  it('spans the 1st of the month through today', () => {
    const { current } = resolvePeriod('mtd', NOW);
    expect(current.start).toBe('2026-05-01');
    expect(current.end).toBe('2026-05-14');
  });

  it('compares against the same window in the prior month', () => {
    const { prior } = resolvePeriod('mtd', NOW);
    expect(prior.start).toBe('2026-04-01');
    expect(prior.end).toBe('2026-04-14');
  });

  it('clamps the prior-month end when the current day overflows', () => {
    // 31 March → February has 28 days in 2026
    const { prior } = resolvePeriod('mtd', new Date('2026-03-31T12:00:00Z'));
    expect(prior.start).toBe('2026-02-01');
    expect(prior.end).toBe('2026-02-28');
  });
});

describe('resolvePeriod — quarter to date', () => {
  it('spans the 1st of the quarter through today', () => {
    const { current } = resolvePeriod('qtd', NOW);
    expect(current.start).toBe('2026-04-01'); // Q2 starts April
    expect(current.end).toBe('2026-05-14');
  });

  it('compares against the prior quarter offset', () => {
    const { prior } = resolvePeriod('qtd', NOW);
    expect(prior.start).toBe('2026-01-01');
    // 43 days into the quarter (Apr 1 → May 14)
    expect(dayOffset('2026-04-01', '2026-05-14')).toBe(43);
    expect(prior.end).toBe(addDays('2026-01-01', 43));
  });
});

describe('resolvePeriod — year to date', () => {
  it('spans Jan 1 through today, comparing to last year', () => {
    const { current, prior } = resolvePeriod('ytd', NOW);
    expect(current.start).toBe('2026-01-01');
    expect(current.end).toBe('2026-05-14');
    expect(prior.start).toBe('2025-01-01');
    expect(prior.end).toBe('2025-05-14');
  });
});

describe('resolvePeriod — trailing 12 months', () => {
  it('spans 12 months back through today', () => {
    const { current } = resolvePeriod('t12m', NOW);
    expect(current.start).toBe('2025-05-14');
    expect(current.end).toBe('2026-05-14');
  });

  it('compares against the preceding 12-month block', () => {
    const { prior } = resolvePeriod('t12m', NOW);
    expect(prior.start).toBe('2024-05-14');
    expect(prior.end).toBe('2025-05-13');
  });
});

describe('date helpers', () => {
  it('dayOffset counts whole days', () => {
    expect(dayOffset('2026-05-01', '2026-05-14')).toBe(13);
    expect(dayOffset('2026-05-14', '2026-05-14')).toBe(0);
  });

  it('addDays moves forward and backward across month boundaries', () => {
    expect(addDays('2026-05-31', 1)).toBe('2026-06-01');
    expect(addDays('2026-05-01', -1)).toBe('2026-04-30');
  });

  it('monthOf extracts YYYY-MM', () => {
    expect(monthOf('2026-05-14')).toBe('2026-05');
  });
});
