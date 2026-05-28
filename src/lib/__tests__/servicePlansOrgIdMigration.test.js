// Structural assertions on the service_plans org_id migration.
//
// service_plans was the one tenant-sensitive table the Phase B1 sweep
// (20260426120000) missed — it had just been renamed from care_plans, and the
// sweep's table list referenced the *clinical* care_plans instead. This
// migration applies the identical Phase B1 recipe to the missed table so the
// Regular caregivers grid (which guards on plan.orgId) can save. These
// invariants lock the recipe in so a future edit can't silently regress it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260531000200_service_plans_org_id.sql',
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260531000200_service_plans_org_id_down.sql',
);

describe('service_plans org_id migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('adds the org_id column idempotently with an FK to organizations', () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.service_plans\s+ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public\.organizations\(id\)/,
    );
  });

  it('backfills NULL rows to Tremendous Care (resolved by slug, not a hardcoded UUID)', () => {
    expect(sql).toMatch(/slug = 'tremendous-care'/);
    expect(sql).toMatch(/UPDATE public\.service_plans SET org_id = v_tc_id WHERE org_id IS NULL/);
    // No hardcoded UUID literal for the org id anywhere in the migration.
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('aborts loudly if the Tremendous Care org row is missing (Phase A dependency)', () => {
    expect(sql).toMatch(/IF v_tc_id IS NULL THEN[\s\S]*?RAISE EXCEPTION/);
  });

  it('tightens to NOT NULL with the shared default_org_id() default', () => {
    expect(sql).toMatch(/ALTER COLUMN org_id SET NOT NULL/);
    expect(sql).toMatch(/ALTER COLUMN org_id SET DEFAULT public\.default_org_id\(\)/);
  });

  it('creates the org_id index matching the Phase B1 naming convention', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_service_plans_org_id\s+ON public\.service_plans \(org_id\)/,
    );
  });

  it('has a post-backfill sanity check that aborts on any remaining NULL', () => {
    expect(sql).toMatch(/org_id IS NULL[\s\S]*?RAISE EXCEPTION[\s\S]*?sanity check failed/);
  });
});

describe('service_plans org_id rollback', () => {
  const sql = readFileSync(ROLLBACK_PATH, 'utf-8');

  it('drops the index and the column', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS public\.idx_service_plans_org_id/);
    expect(sql).toMatch(/ALTER TABLE public\.service_plans DROP COLUMN IF EXISTS org_id/);
  });

  it('does NOT drop the shared default_org_id() helper (owned by Phase B1)', () => {
    expect(sql).not.toMatch(/DROP FUNCTION[\s\S]*?default_org_id/);
  });
});
