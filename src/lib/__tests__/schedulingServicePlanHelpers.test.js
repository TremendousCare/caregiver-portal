import { describe, it, expect } from 'vitest';
import {
  formatStatusLabel,
  statusColors,
  formatDateShort,
  summarizeServicePlan,
  sortServicePlans,
  validateServicePlanDraft,
} from '../../features/scheduling/servicePlanHelpers';

// ─── formatStatusLabel ─────────────────────────────────────────

describe('formatStatusLabel', () => {
  it('formats known statuses', () => {
    expect(formatStatusLabel('draft')).toBe('Draft');
    expect(formatStatusLabel('active')).toBe('Active');
    expect(formatStatusLabel('paused')).toBe('Paused');
    expect(formatStatusLabel('ended')).toBe('Ended');
  });

  it('falls back to the raw value for unknown statuses', () => {
    expect(formatStatusLabel('anything_else')).toBe('anything_else');
  });

  it('returns "Unknown" for missing status', () => {
    expect(formatStatusLabel(null)).toBe('Unknown');
    expect(formatStatusLabel(undefined)).toBe('Unknown');
  });
});

// ─── statusColors ──────────────────────────────────────────────

describe('statusColors', () => {
  it('returns a complete color scheme for each known status', () => {
    for (const s of ['draft', 'active', 'paused', 'ended']) {
      const c = statusColors(s);
      expect(c).toHaveProperty('bg');
      expect(c).toHaveProperty('fg');
      expect(c).toHaveProperty('border');
    }
  });

  it('returns a default scheme for unknown statuses', () => {
    const c = statusColors('bogus');
    expect(c.bg).toBeTruthy();
    expect(c.fg).toBeTruthy();
    expect(c.border).toBeTruthy();
  });

  it('active status uses green tones', () => {
    const c = statusColors('active');
    expect(c.fg).toMatch(/16/); // 166534
  });
});

// ─── formatDateShort ───────────────────────────────────────────

describe('formatDateShort', () => {
  it('returns em-dash for null/undefined', () => {
    expect(formatDateShort(null)).toBe('—');
    expect(formatDateShort(undefined)).toBe('—');
    expect(formatDateShort('')).toBe('—');
  });

  it('formats a YYYY-MM-DD string to a short label', () => {
    const result = formatDateShort('2026-05-01');
    // Implementation uses locale formatting; just assert presence of year
    expect(result).toMatch(/2026/);
  });

  it('returns the raw string for invalid inputs', () => {
    expect(formatDateShort('not a date')).toBe('not a date');
  });
});

// ─── summarizeServicePlan ─────────────────────────────────────────

describe('summarizeServicePlan', () => {
  it('includes start date, "ongoing" end, and hours', () => {
    const s = summarizeServicePlan({
      startDate: '2026-05-01',
      endDate: null,
      hoursPerWeek: 20,
    });
    expect(s).toContain('ongoing');
    expect(s).toContain('20 hrs/week');
  });

  it('includes both dates when end date is set', () => {
    const s = summarizeServicePlan({
      startDate: '2026-05-01',
      endDate: '2026-12-31',
      hoursPerWeek: 40,
    });
    expect(s).toContain('2026');
    expect(s).toContain('40 hrs/week');
    expect(s).not.toContain('ongoing');
  });

  it('omits the hours section when hoursPerWeek is missing', () => {
    const s = summarizeServicePlan({
      startDate: '2026-05-01',
      endDate: null,
    });
    expect(s).not.toContain('hrs/week');
  });

  it('handles zero hours', () => {
    const s = summarizeServicePlan({
      startDate: '2026-05-01',
      hoursPerWeek: 0,
    });
    expect(s).toContain('0 hrs/week');
  });
});

// ─── sortServicePlans ─────────────────────────────────────────────

describe('sortServicePlans', () => {
  it('returns an empty array for null input', () => {
    expect(sortServicePlans(null)).toEqual([]);
    expect(sortServicePlans(undefined)).toEqual([]);
  });

  it('puts active plans before draft, paused, and ended', () => {
    const plans = [
      { id: 'e', status: 'ended', createdAt: '2026-05-01' },
      { id: 'd', status: 'draft', createdAt: '2026-05-01' },
      { id: 'p', status: 'paused', createdAt: '2026-05-01' },
      { id: 'a', status: 'active', createdAt: '2026-05-01' },
    ];
    const sorted = sortServicePlans(plans);
    expect(sorted.map((p) => p.id)).toEqual(['a', 'd', 'p', 'e']);
  });

  it('sorts newer plans first within the same status group', () => {
    const plans = [
      { id: 'a1', status: 'active', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'a2', status: 'active', createdAt: '2026-06-01T00:00:00Z' },
      { id: 'a3', status: 'active', createdAt: '2026-04-01T00:00:00Z' },
    ];
    const sorted = sortServicePlans(plans);
    expect(sorted.map((p) => p.id)).toEqual(['a2', 'a1', 'a3']);
  });

  it('does not mutate the input array', () => {
    const plans = [
      { id: 'e', status: 'ended', createdAt: '2026-05-01' },
      { id: 'a', status: 'active', createdAt: '2026-05-01' },
    ];
    const original = [...plans];
    sortServicePlans(plans);
    expect(plans).toEqual(original);
  });
});

// ─── validateServicePlanDraft ─────────────────────────────────────

describe('validateServicePlanDraft', () => {
  it('rejects missing data', () => {
    expect(validateServicePlanDraft(null)).toBeTruthy();
    expect(validateServicePlanDraft(undefined)).toBeTruthy();
  });

  it('requires a title', () => {
    expect(validateServicePlanDraft({ title: '' })).toMatch(/title/i);
    expect(validateServicePlanDraft({ title: '   ' })).toMatch(/title/i);
    expect(validateServicePlanDraft({})).toMatch(/title/i);
  });

  it('accepts a draft with just a title', () => {
    expect(validateServicePlanDraft({ title: 'Weekly companion' })).toBeNull();
  });

  it('rejects end date before start date', () => {
    const err = validateServicePlanDraft({
      title: 'X',
      startDate: '2026-05-01',
      endDate: '2026-04-01',
    });
    expect(err).toMatch(/end date/i);
  });

  it('accepts equal start and end dates', () => {
    expect(
      validateServicePlanDraft({
        title: 'X',
        startDate: '2026-05-01',
        endDate: '2026-05-01',
      }),
    ).toBeNull();
  });

  it('rejects non-numeric hours per week', () => {
    const err = validateServicePlanDraft({ title: 'X', hoursPerWeek: 'lots' });
    expect(err).toMatch(/hours/i);
  });

  it('rejects zero or negative hours per week', () => {
    expect(validateServicePlanDraft({ title: 'X', hoursPerWeek: 0 })).toMatch(/hours/i);
    expect(validateServicePlanDraft({ title: 'X', hoursPerWeek: -5 })).toMatch(/hours/i);
  });

  it('rejects hours per week over 168', () => {
    expect(validateServicePlanDraft({ title: 'X', hoursPerWeek: 200 })).toMatch(/168/);
  });

  it('accepts a valid draft with all fields', () => {
    expect(
      validateServicePlanDraft({
        title: 'Weekly companion',
        serviceType: 'companion + light housekeeping',
        hoursPerWeek: 20,
        startDate: '2026-05-01',
        endDate: '2026-12-31',
        status: 'active',
        notes: 'Mornings preferred',
      }),
    ).toBeNull();
  });

  it('treats empty-string hoursPerWeek as not set (valid)', () => {
    expect(validateServicePlanDraft({ title: 'X', hoursPerWeek: '' })).toBeNull();
  });
});
