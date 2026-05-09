import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the user_roles_admins_read_all migration.
// The migration's own DO block is the runtime safety net (it aborts
// the deploy if the policy is missing after CREATE). This spec catches
// regressions at build time — e.g., someone narrowing the predicate or
// flipping the role grant.

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260509000000_user_roles_admins_read_all.sql'
);

const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260509000000_user_roles_admins_read_all_down.sql'
);

describe('user_roles_admins_read_all migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');
  const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

  it('creates the user_roles_admins_read_all policy on public.user_roles', () => {
    expect(sql).toMatch(
      /CREATE POLICY user_roles_admins_read_all ON public\.user_roles/
    );
  });

  it('targets the authenticated role only — not anon or public', () => {
    expect(sql).toMatch(/TO authenticated/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO anon/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO public[^.]/);
  });

  it('is a SELECT-only policy (does not grant write access)', () => {
    expect(sql).toMatch(/FOR SELECT/);
    expect(sql).not.toMatch(/FOR INSERT/);
    expect(sql).not.toMatch(/FOR UPDATE/);
    expect(sql).not.toMatch(/FOR DELETE/);
    expect(sql).not.toMatch(/FOR ALL/);
  });

  it('gates visibility on role = admin via an EXISTS check on user_roles', () => {
    // The predicate must look up the caller's row in user_roles and
    // require role = 'admin'. Anything looser would re-open the leak
    // that 20260418210000_caregiver_portal_rls.sql was meant to close.
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM public\.user_roles ur/);
    expect(sql).toMatch(/ur\.role = 'admin'/);
    expect(sql).toMatch(/ur\.email = lower\(\(SELECT auth\.jwt\(\)\) ->> 'email'\)/);
  });

  it('is idempotent — DROP POLICY IF EXISTS precedes CREATE POLICY', () => {
    const dropIdx = sql.indexOf('DROP POLICY IF EXISTS user_roles_admins_read_all');
    const createIdx = sql.indexOf('CREATE POLICY user_roles_admins_read_all');
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(dropIdx);
  });

  it('aborts the deploy if the policy is missing after CREATE', () => {
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/user_roles_admins_read_all policy missing/);
  });

  it('does not modify or drop the existing user_roles_read_own policy', () => {
    // The whole point of layering: member self-reads must keep working.
    // Comment mentions are fine; what matters is that no SQL statement
    // targets user_roles_read_own.
    expect(sql).not.toMatch(/DROP POLICY[^;]*user_roles_read_own/);
    expect(sql).not.toMatch(/ALTER POLICY[^;]*user_roles_read_own/);
    expect(sql).not.toMatch(/CREATE POLICY user_roles_read_own/);
  });

  it('does not touch table schema', () => {
    expect(sql).not.toMatch(/ALTER TABLE/);
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/CREATE TABLE/);
  });

  it('rollback drops only the new policy, not user_roles_read_own', () => {
    expect(rollback).toMatch(
      /DROP POLICY IF EXISTS user_roles_admins_read_all ON public\.user_roles/
    );
    // Comments may mention other policy names for context; what matters
    // is that the rollback does not issue SQL against them.
    expect(rollback).not.toMatch(/DROP POLICY[^;]*user_roles_read_own/);
    expect(rollback).not.toMatch(/DROP POLICY[^;]*admins_update_user_roles/);
    expect(rollback).not.toMatch(/DROP POLICY[^;]*user_roles_admins_insert/);
  });
});
