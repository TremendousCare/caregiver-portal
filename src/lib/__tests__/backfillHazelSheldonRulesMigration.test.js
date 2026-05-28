// Structural assertions on the Hazel/Sheldon caregiver-rule backfill.
//
// This is a one-time data migration that seeds service_plan_caregiver_rules
// from the high-confidence shift assignments of two pre-feature clients. The
// invariants below guard the properties that make it safe to ship and re-run:
// idempotent (guarded insert), non-destructive (no UPDATE/DELETE of existing
// rules), org-scoped via the shared helper, and rollback-able by tag.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260531000300_backfill_service_plan_caregiver_rules_hazel_sheldon.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260531000300_backfill_service_plan_caregiver_rules_hazel_sheldon_down.sql',
);

const BACKFILL_TAG = 'system:backfill-20260531';

describe('Hazel/Sheldon caregiver-rule backfill migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('inserts into service_plan_caregiver_rules with the expected columns', () => {
    expect(sql).toMatch(
      /INSERT INTO public\.service_plan_caregiver_rules\s*\(\s*org_id, service_plan_id, day_of_week, caregiver_id, effective_from, created_by, notes\s*\)/,
    );
  });

  it('is org-scoped via the shared default_org_id() helper, not a hardcoded org UUID', () => {
    expect(sql).toMatch(/public\.default_org_id\(\)/);
  });

  it('is idempotent — guarded by NOT EXISTS on (service_plan_id, day_of_week)', () => {
    expect(sql).toMatch(
      /WHERE NOT EXISTS \(\s*SELECT 1\s*FROM public\.service_plan_caregiver_rules r\s*WHERE r\.service_plan_id = v\.service_plan_id::uuid\s*AND r\.day_of_week = v\.day_of_week::smallint\s*\)/,
    );
  });

  it('is non-destructive — performs no UPDATE or DELETE on existing rules', () => {
    expect(sql).not.toMatch(/UPDATE public\.service_plan_caregiver_rules/);
    expect(sql).not.toMatch(/DELETE FROM public\.service_plan_caregiver_rules/);
  });

  it('joins service_plans so a removed plan is skipped, and derives effective_from from start_date', () => {
    expect(sql).toMatch(/JOIN public\.service_plans sp ON sp\.id = v\.service_plan_id::uuid/);
    expect(sql).toMatch(/COALESCE\(sp\.start_date, CURRENT_DATE\)/);
  });

  it('tags every seeded row so the rollback can target exactly these rows', () => {
    expect(sql).toContain(`'${BACKFILL_TAG}'`);
  });

  it('seeds exactly the 13 high-confidence (plan, day, caregiver) rules', () => {
    // Each rule is a VALUES tuple: ('<plan uuid>', <dow int>, '<caregiver uuid>')
    const tuples = sql.match(
      /\(\s*'[0-9a-f-]{36}'\s*,\s*[0-6]\s*,\s*'[0-9a-f-]{36}'\s*\)/gi,
    ) || [];
    expect(tuples.length).toBe(13);
  });

  it('covers Hazel (5 weekday rules) and the four consistently-staffed Sheldon blocks', () => {
    // Hazel — Elizabeth Nicasio, Mon-Fri on the weekday plan
    const hazel = sql.match(/'7fb42d06-012a-4405-a743-659a39135394', [1-5], '440d7f70-d42c-4880-9331-ec642485909d'/g) || [];
    expect(hazel.length).toBe(5);
    // Sheldon — Ciara Hinojoza, Mon-Fri on the 6am-3pm day plan
    const sheldonDay = sql.match(/'d570ee63-c387-4c86-be25-eb4fcf4cd9bd', [1-5], 'b9c3944d-1c14-4af9-9dcd-f6fb23670aad'/g) || [];
    expect(sheldonDay.length).toBe(5);
    // Sheldon weekend blocks
    expect(sql).toMatch(/'fcd7cec5-00e7-4058-ae2e-a8552c6f4db6', 6, 'b2b37e5f-84a0-4e41-a8cb-93bf741cfdc2'/); // Sat day, Leslie
    expect(sql).toMatch(/'313d7055-17a2-4d0e-9a79-ca4356a59401', 6, '34596b08-02cf-430a-b8f7-eba393370191'/); // Sat night, Michael
    expect(sql).toMatch(/'b43fd58d-b042-488e-b953-583b84390917', 0, '34596b08-02cf-430a-b8f7-eba393370191'/); // Sun night, Michael
  });
});

describe('Hazel/Sheldon caregiver-rule backfill rollback', () => {
  const sql = readFileSync(ROLLBACK_PATH, 'utf-8');

  it('deletes only the rows this backfill created, by tag', () => {
    expect(sql).toMatch(
      new RegExp(`DELETE FROM public\\.service_plan_caregiver_rules\\s*WHERE created_by = '${BACKFILL_TAG}'`),
    );
  });
});
