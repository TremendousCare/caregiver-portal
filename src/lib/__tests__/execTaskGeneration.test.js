import { describe, it, expect } from 'vitest';
import {
  isoDate,
  addDays,
  buildDueAt,
  planLifecycleInstance,
  planLifecycleBatch,
  inferCadence,
  periodFromDate,
  planRecurringInstance,
  emptyRunResult,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_LOOKAHEAD_DAYS,
} from '../exec/execTaskGeneration.js';

const NOW = new Date('2026-05-28T15:00:00Z');

describe('isoDate / addDays', () => {
  it('isoDate formats a Date in UTC', () => {
    expect(isoDate(new Date('2026-05-28T23:30:00Z'))).toBe('2026-05-28');
  });
  it('addDays handles month rollover', () => {
    expect(addDays('2026-05-30', 5)).toBe('2026-06-04');
  });
  it('addDays handles negative offsets', () => {
    expect(addDays('2026-05-01', -10)).toBe('2026-04-21');
  });
  it('addDays handles leap-year February', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });
  it('addDays returns null for null input', () => {
    expect(addDays(null, 5)).toBe(null);
  });
});

describe('buildDueAt', () => {
  it('builds 09:00 UTC due-at by default', () => {
    expect(buildDueAt('2026-05-28', 0)).toBe('2026-05-28T09:00:00Z');
  });
  it('adds offset days', () => {
    expect(buildDueAt('2026-05-28', 30)).toBe('2026-06-27T09:00:00Z');
  });
});

// ─── Lifecycle ────────────────────────────────────────────────

const baseLifecycleTemplate = {
  id: 't-30day',
  org_id: 'org-1',
  name: '30-day check-in',
  description: 'desc',
  anchor_type: 'hire_date',
  offset_days: 30,
  recurrence_interval_days: null,
  next_fire_at: null,
  default_assignee_email: null,
  default_urgency: 'critical',
  visibility: 'owner',
  active: true,
};
const baseStaff = {
  email: 'alex@tc.com',
  hire_date: '2026-04-28', // exactly 30 days before NOW
  manager_email: 'kevin@tc.com',
  active: true,
};

describe('planLifecycleInstance', () => {
  it('builds an insert payload when hire_date + offset === today', () => {
    const r = planLifecycleInstance({
      template: baseLifecycleTemplate,
      staff: baseStaff,
      now: NOW,
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      lookaheadDays: DEFAULT_LOOKAHEAD_DAYS,
    });
    expect(r).not.toBe(null);
    expect(r.org_id).toBe('org-1');
    expect(r.template_id).toBe('t-30day');
    expect(r.category).toBe('lifecycle');
    expect(r.anchor_staff_email).toBe('alex@tc.com');
    expect(r.anchor_date).toBe('2026-04-28');
    expect(r.due_at).toBe('2026-05-28T09:00:00Z');
    expect(r.assigned_to).toBe('kevin@tc.com'); // falls back to manager
    expect(r.urgency).toBe('critical');
  });

  it('prefers template default_assignee_email over manager_email', () => {
    const r = planLifecycleInstance({
      template: { ...baseLifecycleTemplate, default_assignee_email: 'kevin@tc.com' },
      staff: { ...baseStaff, manager_email: 'someone@else.com' },
      now: NOW,
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      lookaheadDays: DEFAULT_LOOKAHEAD_DAYS,
    });
    expect(r.assigned_to).toBe('kevin@tc.com');
  });

  it('returns null when template is inactive', () => {
    const r = planLifecycleInstance({
      template: { ...baseLifecycleTemplate, active: false },
      staff: baseStaff,
      now: NOW,
      lookbackDays: 30,
      lookaheadDays: 14,
    });
    expect(r).toBe(null);
  });

  it('returns null when staff is inactive', () => {
    const r = planLifecycleInstance({
      template: baseLifecycleTemplate,
      staff: { ...baseStaff, active: false },
      now: NOW,
      lookbackDays: 30,
      lookaheadDays: 14,
    });
    expect(r).toBe(null);
  });

  it('returns null when due date is beyond lookahead', () => {
    // hire_date 30 days before today + offset 90 = 60 days from today
    const r = planLifecycleInstance({
      template: { ...baseLifecycleTemplate, offset_days: 90 },
      staff: baseStaff,
      now: NOW,
      lookbackDays: 30,
      lookaheadDays: 14,
    });
    expect(r).toBe(null);
  });

  it('still fires for an overdue lifecycle inside the lookback window', () => {
    // hire_date 35 days ago, offset 30 → due 5 days ago (within 30-day lookback)
    const r = planLifecycleInstance({
      template: baseLifecycleTemplate,
      staff: { ...baseStaff, hire_date: addDays(isoDate(NOW), -35) },
      now: NOW,
      lookbackDays: 30,
      lookaheadDays: 14,
    });
    expect(r).not.toBe(null);
  });

  it('returns null when due predates the lookback window', () => {
    const r = planLifecycleInstance({
      template: baseLifecycleTemplate,
      staff: { ...baseStaff, hire_date: addDays(isoDate(NOW), -100) },
      now: NOW,
      lookbackDays: 30,
      lookaheadDays: 14,
    });
    expect(r).toBe(null);
  });

  it('returns null when template.anchor_type is not hire_date', () => {
    const r = planLifecycleInstance({
      template: { ...baseLifecycleTemplate, anchor_type: 'fixed_date' },
      staff: baseStaff,
      now: NOW,
      lookbackDays: 30,
      lookaheadDays: 14,
    });
    expect(r).toBe(null);
  });

  it('returns null when staff has no hire_date', () => {
    const r = planLifecycleInstance({
      template: baseLifecycleTemplate,
      staff: { ...baseStaff, hire_date: null },
      now: NOW,
      lookbackDays: 30,
      lookaheadDays: 14,
    });
    expect(r).toBe(null);
  });
});

describe('planLifecycleBatch', () => {
  it('produces one row per matching staff member', () => {
    const staff = [
      baseStaff,
      { ...baseStaff, email: 'jordan@tc.com', hire_date: addDays(isoDate(NOW), -30) },
      { ...baseStaff, email: 'morgan@tc.com', hire_date: '2020-01-01' }, // too old
      { ...baseStaff, email: 'pat@tc.com', active: false }, // inactive
    ];
    const rows = planLifecycleBatch({
      template: baseLifecycleTemplate,
      staff,
      now: NOW,
      lookbackDays: 30,
      lookaheadDays: 14,
    });
    expect(rows.map((r) => r.anchor_staff_email).sort()).toEqual(['alex@tc.com', 'jordan@tc.com']);
  });

  it('returns empty array when no staff match', () => {
    const rows = planLifecycleBatch({
      template: baseLifecycleTemplate,
      staff: [{ ...baseStaff, hire_date: '2000-01-01' }],
      now: NOW,
      lookbackDays: 30,
      lookaheadDays: 14,
    });
    expect(rows).toEqual([]);
  });

  it('safely handles null/undefined staff input', () => {
    expect(planLifecycleBatch({
      template: baseLifecycleTemplate,
      staff: null,
      now: NOW,
      lookbackDays: 30,
      lookaheadDays: 14,
    })).toEqual([]);
  });
});

// ─── Cadence inference + period derivation ──────────────────────

describe('inferCadence', () => {
  it('classifies weekly (≤7)', () => { expect(inferCadence(7)).toBe('weekly'); });
  it('classifies monthly (8–31)', () => { expect(inferCadence(30)).toBe('monthly'); });
  it('classifies quarterly (32–100)', () => { expect(inferCadence(90)).toBe('quarterly'); });
  it('classifies annual (≥200)', () => { expect(inferCadence(365)).toBe('annual'); });
  it('falls back to "date" for irregular intervals', () => { expect(inferCadence(150)).toBe('date'); });
  it('falls back to "date" for null', () => { expect(inferCadence(null)).toBe('date'); });
});

describe('periodFromDate', () => {
  it('annual → year', () => { expect(periodFromDate('2026-04-15', 'annual')).toBe('2026'); });
  it('quarterly Q1 → YYYY-Q1', () => { expect(periodFromDate('2026-02-15', 'quarterly')).toBe('2026-Q1'); });
  it('quarterly Q2 → YYYY-Q2', () => { expect(periodFromDate('2026-04-15', 'quarterly')).toBe('2026-Q2'); });
  it('quarterly Q3', () => { expect(periodFromDate('2026-08-15', 'quarterly')).toBe('2026-Q3'); });
  it('quarterly Q4', () => { expect(periodFromDate('2026-12-15', 'quarterly')).toBe('2026-Q4'); });
  it('monthly → YYYY-MM', () => { expect(periodFromDate('2026-04-05', 'monthly')).toBe('2026-04'); });
  it('weekly → Monday of week', () => {
    // 2026-05-28 is a Thursday → Monday is 2026-05-25
    expect(periodFromDate('2026-05-28', 'weekly')).toBe('2026-05-25');
  });
  it('"date" cadence preserves the input', () => {
    expect(periodFromDate('2026-05-28', 'date')).toBe('2026-05-28');
  });
});

// ─── Recurring ─────────────────────────────────────────────────

const baseRecurringTemplate = {
  id: 't-quarterly',
  org_id: 'org-1',
  name: 'Quarterly OKR setting',
  description: null,
  anchor_type: 'fixed_date',
  offset_days: null,
  recurrence_interval_days: 90,
  next_fire_at: '2026-05-28T09:00:00Z', // exactly today (UTC)
  default_assignee_email: 'kevin@tc.com',
  default_urgency: 'critical',
  visibility: 'owner',
  active: true,
};

describe('planRecurringInstance', () => {
  it('returns row + bumped next_fire_at when due today', () => {
    const r = planRecurringInstance({
      template: baseRecurringTemplate,
      now: NOW,
      lookaheadDays: DEFAULT_LOOKAHEAD_DAYS,
    });
    expect(r).not.toBe(null);
    expect(r.row.category).toBe('recurring');
    expect(r.row.org_id).toBe('org-1');
    expect(r.row.template_id).toBe('t-quarterly');
    expect(r.row.recurrence_period).toBe('2026-Q2');
    expect(r.row.due_at).toBe('2026-05-28T09:00:00Z');
    expect(r.next_fire_at).toBe('2026-08-26T09:00:00Z'); // +90 days
    expect(r.row.assigned_to).toBe('kevin@tc.com');
  });

  it('still fires for an overdue template (recovery path)', () => {
    const r = planRecurringInstance({
      template: { ...baseRecurringTemplate, next_fire_at: '2026-05-01T09:00:00Z' },
      now: NOW,
      lookaheadDays: DEFAULT_LOOKAHEAD_DAYS,
    });
    expect(r).not.toBe(null);
    expect(r.row.recurrence_period).toBe('2026-Q2');
  });

  it('returns null when fire date is beyond lookahead', () => {
    const r = planRecurringInstance({
      template: { ...baseRecurringTemplate, next_fire_at: '2026-07-01T09:00:00Z' },
      now: NOW,
      lookaheadDays: 14,
    });
    expect(r).toBe(null);
  });

  it('returns null when template is inactive', () => {
    const r = planRecurringInstance({
      template: { ...baseRecurringTemplate, active: false },
      now: NOW,
      lookaheadDays: 14,
    });
    expect(r).toBe(null);
  });

  it('returns null when next_fire_at is missing (template not yet activated)', () => {
    const r = planRecurringInstance({
      template: { ...baseRecurringTemplate, next_fire_at: null },
      now: NOW,
      lookaheadDays: 14,
    });
    expect(r).toBe(null);
  });

  it('returns null when recurrence_interval_days is missing', () => {
    const r = planRecurringInstance({
      template: { ...baseRecurringTemplate, recurrence_interval_days: null },
      now: NOW,
      lookaheadDays: 14,
    });
    expect(r).toBe(null);
  });

  it('uses monthly cadence for 30-day intervals', () => {
    const r = planRecurringInstance({
      template: {
        ...baseRecurringTemplate,
        recurrence_interval_days: 30,
        next_fire_at: '2026-05-28T09:00:00Z',
      },
      now: NOW,
      lookaheadDays: 14,
    });
    expect(r.row.recurrence_period).toBe('2026-05');
  });

  it('uses weekly cadence for 7-day intervals', () => {
    const r = planRecurringInstance({
      template: {
        ...baseRecurringTemplate,
        recurrence_interval_days: 7,
        next_fire_at: '2026-05-28T09:00:00Z', // Thursday
      },
      now: NOW,
      lookaheadDays: 14,
    });
    expect(r.row.recurrence_period).toBe('2026-05-25'); // Monday
  });

  it('uses annual cadence for 365-day intervals', () => {
    const r = planRecurringInstance({
      template: {
        ...baseRecurringTemplate,
        recurrence_interval_days: 365,
        next_fire_at: '2026-05-28T09:00:00Z',
      },
      now: NOW,
      lookaheadDays: 14,
    });
    expect(r.row.recurrence_period).toBe('2026');
  });
});

describe('emptyRunResult', () => {
  it('builds zero-state container with all counters', () => {
    const r = emptyRunResult('org-x');
    expect(r).toEqual({
      org_id: 'org-x',
      lifecycle_inserted: 0,
      lifecycle_skipped_existing: 0,
      recurring_inserted: 0,
      recurring_skipped_existing: 0,
      templates_processed: 0,
      staff_processed: 0,
      errors: [],
    });
  });
});
