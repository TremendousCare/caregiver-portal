// Structural assertions on migration 20260528000300_exec_seed_templates.
//
// Locks in: exactly the 25 agreed-on template slugs are seeded,
// every seed targets all organizations via FROM organizations o,
// every seed is idempotent via ON CONFLICT (org_id, slug) DO NOTHING,
// and every seed is shipped active=false.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260528000300_exec_seed_templates.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260528000300_exec_seed_templates_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollbackSql = readFileSync(ROLLBACK_PATH, 'utf-8');

const EXPECTED_SLUGS = [
  // financial (8)
  'monthly_pl_review',
  'monthly_cash_position',
  'monthly_ar_aging',
  'quarterly_tax_estimate',
  'quarterly_vendor_spend_audit',
  'annual_budget_planning',
  'annual_audit_prep',
  'annual_insurance_renewals',
  // compliance (5)
  'annual_hipaa_risk_assessment',
  'annual_baa_renewals',
  'annual_state_license_renewal',
  'annual_dol_posters_refresh',
  'annual_handbook_review',
  // people (6)
  'hire_30_day_checkin',
  'hire_60_day_checkin',
  'hire_90_day_checkin',
  'anniversary_review',
  'quarterly_comp_benchmarking',
  'quarterly_org_chart_review',
  // strategic (4)
  'weekly_owner_1on1',
  'quarterly_okr_setting',
  'quarterly_okr_retrospective',
  'annual_strategy_offsite',
  // operational (2)
  'monthly_subscription_audit',
  'quarterly_security_advisor_review',
];

describe('exec_seed_templates migration', () => {
  it('seeds exactly 25 templates', () => {
    expect(EXPECTED_SLUGS.length).toBe(25);
    EXPECTED_SLUGS.forEach((slug) => {
      // Slug appears at least once as a literal in the INSERT
      const re = new RegExp(`'${slug}'`);
      expect(sql).toMatch(re);
    });
  });

  it('every seed targets all organizations via FROM organizations o', () => {
    const inserts = sql.match(/INSERT INTO public\.exec_task_templates[\s\S]*?ON CONFLICT \(org_id, slug\) DO NOTHING/g) ?? [];
    // Expect at least one INSERT per seeded slug
    expect(inserts.length).toBeGreaterThanOrEqual(EXPECTED_SLUGS.length);
    inserts.forEach((insert) => {
      expect(insert).toMatch(/FROM public\.organizations o/);
    });
  });

  it('every seed is idempotent (ON CONFLICT DO NOTHING)', () => {
    const inserts = sql.match(/INSERT INTO public\.exec_task_templates[\s\S]*?(?=INSERT INTO|-- ─|DO \$\$)/g) ?? [];
    inserts.forEach((insert) => {
      expect(insert).toMatch(/ON CONFLICT \(org_id, slug\) DO NOTHING/);
    });
  });

  it('every seed ships active=false (owner enables manually)', () => {
    // The 13th positional value in each insert is `active`. Scan the
    // file for the pattern "false, <sort_order>" inside each insert
    // and assert no insert sets active=true.
    const inserts = sql.match(/INSERT INTO public\.exec_task_templates[\s\S]*?ON CONFLICT \(org_id, slug\) DO NOTHING/g) ?? [];
    inserts.forEach((insert) => {
      // The SELECT clause ends with `..., false, NNN` for each insert
      // (visibility 'owner', active false, sort_order)
      expect(insert).toMatch(/'owner',\s*false,\s*\d+/);
    });
  });

  it('lifecycle templates use anchor_type=hire_date with offset_days', () => {
    // The four lifecycle slugs: hire_30/60/90 + anniversary_review
    ['hire_30_day_checkin', 'hire_60_day_checkin', 'hire_90_day_checkin', 'anniversary_review'].forEach((slug) => {
      // Find the INSERT for this slug
      const re = new RegExp(`'${slug}'[\\s\\S]*?'lifecycle',\\s*'hire_date',\\s*\\d+`);
      expect(sql).toMatch(re);
    });
  });

  it('30/60/90 use the right offset_days', () => {
    expect(sql).toMatch(/'hire_30_day_checkin'[\s\S]*?'lifecycle', 'hire_date', 30/);
    expect(sql).toMatch(/'hire_60_day_checkin'[\s\S]*?'lifecycle', 'hire_date', 60/);
    expect(sql).toMatch(/'hire_90_day_checkin'[\s\S]*?'lifecycle', 'hire_date', 90/);
    expect(sql).toMatch(/'anniversary_review'[\s\S]*?'lifecycle', 'hire_date', 365/);
  });

  it('recurring templates use anchor_type=fixed_date with recurrence_interval_days', () => {
    // Spot check several
    expect(sql).toMatch(/'monthly_pl_review'[\s\S]*?'recurring', 'fixed_date', 30/);
    expect(sql).toMatch(/'quarterly_okr_setting'[\s\S]*?'recurring', 'fixed_date', 90/);
    expect(sql).toMatch(/'annual_hipaa_risk_assessment'[\s\S]*?'recurring', 'fixed_date', 365/);
    expect(sql).toMatch(/'weekly_owner_1on1'[\s\S]*?'recurring', 'fixed_date', 7/);
  });

  it('the 90-day check-in includes the continue/PIP/no decision question', () => {
    // Critical product check: the 90-day must force the decision
    const ninetyDayInsert = sql.match(/'hire_90_day_checkin'[\s\S]*?ON CONFLICT \(org_id, slug\) DO NOTHING/)?.[0] ?? '';
    expect(ninetyDayInsert).toMatch(/"options":\["yes","yes_with_pip","no"\]/);
    expect(ninetyDayInsert).toMatch(/"id":"decision"/);
  });

  it('rollback removes all 25 slugs', () => {
    EXPECTED_SLUGS.forEach((slug) => {
      const re = new RegExp(`'${slug}'`);
      expect(rollbackSql).toMatch(re);
    });
    expect(rollbackSql).toMatch(/DELETE FROM public\.exec_task_templates[\s\S]*?WHERE slug IN/);
  });
});
