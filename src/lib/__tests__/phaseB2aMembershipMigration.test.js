import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the Phase B2a migration. The migration's own
// PL/pgSQL DO blocks are the runtime safety net (they abort the deploy
// if any active auth.users row is left without a membership). This spec
// is a cheap regression net that catches accidental deletion of those
// guards or the trigger plumbing in future PRs.
const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260501000000_phase_b2a_membership_integrity.sql'
);

describe('Phase B2a membership integrity migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('uses the org_id helper rather than hardcoding the Tremendous Care UUID', () => {
    expect(sql).toMatch(/public\.default_org_id\(\)/);
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('makes every backfill INSERT idempotent via ON CONFLICT', () => {
    const inserts = sql.match(/INSERT INTO public\.org_memberships/gi) ?? [];
    const onConflicts = sql.match(/ON CONFLICT \(org_id, user_id\) DO NOTHING/gi) ?? [];
    expect(inserts.length).toBeGreaterThanOrEqual(3);
    expect(onConflicts.length).toBe(inserts.length);
  });

  it('falls back to the least-privileged role for unknown users', () => {
    expect(sql).toMatch(/COALESCE\(v_role, 'caregiver'\)/);
  });

  it('installs the AFTER INSERT trigger on auth.users', () => {
    expect(sql).toMatch(/CREATE TRIGGER on_auth_user_created_membership/);
    expect(sql).toMatch(/AFTER INSERT ON auth\.users/);
    expect(sql).toMatch(/EXECUTE FUNCTION public\.handle_new_user_membership\(\)/);
  });

  it('drops any prior trigger before recreating to keep the migration idempotent', () => {
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS on_auth_user_created_membership ON auth\.users/);
  });

  it('declares the trigger function SECURITY DEFINER with a locked search_path', () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public, pg_temp/);
  });

  it('grants execute on the trigger function to supabase_auth_admin', () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.handle_new_user_membership\(\) TO supabase_auth_admin/
    );
  });

  it('aborts the migration if any active user is left without a membership', () => {
    expect(sql).toMatch(/Phase B2a sanity check failed/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });
});
