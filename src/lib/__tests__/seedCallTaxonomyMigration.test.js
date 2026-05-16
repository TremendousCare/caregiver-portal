/**
 * Phase 1.6.1 — seed_tc_call_taxonomy migration.
 *
 * Pins the locked taxonomy slugs so a future PR can't silently
 * rename / drop one without an explicit test update — the slugs
 * are the contract the Phase 1.6.2 call_analyst prompt references.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SEED_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260516010002_agent_platform_phase_1_6_1_seed_tc_call_taxonomy.sql',
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260516010002_agent_platform_phase_1_6_1_seed_tc_call_taxonomy_down.sql',
);

const sql      = readFileSync(SEED_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

const CALL_TYPE_SLUGS = [
  'recruiting', 'client_care', 'bd_outreach', 'payroll',
  'scheduling', 'complaint', 'other',
];

const RED_FLAG_SLUGS = [
  'compliance_concern', 'safety_issue', 'client_dissatisfaction',
  'caregiver_distress', 'payment_dispute', 'legal_or_hr_risk',
  'urgent_scheduling_gap', 'other',
];

describe('seed_tc_call_taxonomy migration', () => {
  it('targets call_taxonomy with public.default_org_id()', () => {
    expect(sql).toMatch(/INSERT INTO public\.call_taxonomy/);
    expect(sql).toMatch(/public\.default_org_id\(\)/);
  });

  it('is idempotent via ON CONFLICT DO NOTHING on the natural key', () => {
    expect(sql).toMatch(/ON CONFLICT \(org_id, axis, slug\) DO NOTHING/);
  });

  it('seeds all seven call_type slugs', () => {
    for (const slug of CALL_TYPE_SLUGS) {
      const re = new RegExp(`'call_type', '${slug}'`);
      expect(sql).toMatch(re);
    }
  });

  it('seeds all eight red_flag slugs', () => {
    for (const slug of RED_FLAG_SLUGS) {
      const re = new RegExp(`'red_flag', '${slug}'`);
      expect(sql).toMatch(re);
    }
  });

  it('asserts ≥ 15 rows landed (sanity DO block)', () => {
    expect(sql).toMatch(/expected ≥ 15 rows for Tremendous Care/);
  });

  it("escapes the apostrophe in 'workers' comp'", () => {
    // Subtle SQL-injection-via-typo guardrail: confirm the escaped
    // version landed, not the raw apostrophe.
    expect(sql).toMatch(/workers'' comp/);
  });
});

describe('seed rollback', () => {
  it('deletes only the seeded slugs (preserves operator-added rows)', () => {
    expect(rollback).toMatch(/DELETE FROM public\.call_taxonomy/);
    expect(rollback).toMatch(/org_id = public\.default_org_id\(\)/);
    for (const slug of CALL_TYPE_SLUGS) {
      expect(rollback).toContain(`'${slug}'`);
    }
    for (const slug of RED_FLAG_SLUGS) {
      expect(rollback).toContain(`'${slug}'`);
    }
  });
});
