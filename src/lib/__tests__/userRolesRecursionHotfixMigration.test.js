import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the recursion hotfix migration. The
// migration's own DO sanity block is the runtime safety net (it
// raises if the function or policy is missing post-create). This
// spec catches accidental regressions in PR review — most
// importantly, anyone re-introducing an inline EXISTS in the policy
// USING clause, which was the cause of the original incident.

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260509100000_fix_user_roles_admins_read_all_recursion.sql'
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260509100000_fix_user_roles_admins_read_all_recursion_down.sql'
);

describe('user_roles_admins_read_all recursion hotfix', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');
  const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

  it('drops the recursive policy before recreating it', () => {
    const dropIdx = sql.indexOf('DROP POLICY IF EXISTS user_roles_admins_read_all');
    const createIdx = sql.indexOf('CREATE POLICY user_roles_admins_read_all');
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(dropIdx);
  });

  it('creates a STABLE SECURITY DEFINER public.is_admin() function', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.is_admin\(\)/);
    expect(sql).toMatch(/RETURNS boolean/);
    expect(sql).toMatch(/STABLE/);
    expect(sql).toMatch(/SECURITY DEFINER/);
  });

  it('locks the function search_path to public (defensive)', () => {
    // Best practice for SECURITY DEFINER funcs: pin search_path so
    // a malicious schema in pg_temp can't shadow public objects.
    // Mirrors how public.is_staff() is defined.
    expect(sql).toMatch(/SET search_path TO 'public'/);
  });

  it("keys the admin check on the caller's JWT email, lowercased", () => {
    // Inside the function body — this EXISTS is fine because the
    // function runs as SECURITY DEFINER (bypasses RLS on user_roles).
    expect(sql).toMatch(/email = lower\(\(auth\.jwt\(\) ->> 'email'\)\)/);
    expect(sql).toMatch(/role = 'admin'/);
  });

  it('the recreated policy uses public.is_admin(), not an inline EXISTS', () => {
    // Guard against regression — an inline EXISTS in a SELECT policy
    // on user_roles is what caused the recursion incident.
    expect(sql).toMatch(
      /CREATE POLICY user_roles_admins_read_all ON public\.user_roles[\s\S]{0,200}USING \(public\.is_admin\(\)\)/
    );
  });

  it('the policy USING clause does not contain a SELECT from user_roles', () => {
    // Match the CREATE POLICY block specifically and assert it
    // doesn't pull in the function-body EXISTS by accident.
    const policyMatch = sql.match(
      /CREATE POLICY user_roles_admins_read_all[\s\S]*?;\s*$/m
    );
    expect(policyMatch).toBeTruthy();
    expect(policyMatch[0]).not.toMatch(/SELECT 1 FROM\s+(public\.)?user_roles/);
  });

  it('targets only the authenticated role for SELECT', () => {
    expect(sql).toMatch(/FOR SELECT[\s\n]+TO authenticated/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO anon/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO public[^.]/);
  });

  it('aborts the deploy if the function or policy is missing post-create', () => {
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/is_admin\(\) function missing/);
    expect(sql).toMatch(/user_roles_admins_read_all policy missing/);
  });

  it('verifies the new function is actually SECURITY DEFINER (prosecdef = true)', () => {
    // Without this check, someone could create a SECURITY INVOKER
    // function with the same name and the policy would silently
    // recurse again. The guard pins prosecdef = true.
    expect(sql).toMatch(/prosecdef = true/);
  });

  it('does not modify or drop user_roles_read_own', () => {
    expect(sql).not.toMatch(/DROP POLICY[^;]*user_roles_read_own/);
    expect(sql).not.toMatch(/ALTER POLICY[^;]*user_roles_read_own/);
    expect(sql).not.toMatch(/CREATE POLICY user_roles_read_own/);
  });

  it('does not alter user_roles table schema', () => {
    expect(sql).not.toMatch(/ALTER TABLE.*user_roles/);
    expect(sql).not.toMatch(/DROP TABLE.*user_roles/);
    expect(sql).not.toMatch(/CREATE TABLE.*user_roles/);
  });

  it('rollback drops the policy first, then the function', () => {
    const policyDropIdx = rollback.indexOf(
      'DROP POLICY IF EXISTS user_roles_admins_read_all'
    );
    const funcDropIdx = rollback.indexOf(
      'DROP FUNCTION IF EXISTS public.is_admin'
    );
    expect(policyDropIdx).toBeGreaterThanOrEqual(0);
    expect(funcDropIdx).toBeGreaterThan(policyDropIdx);
  });

  it('rollback does not recreate the buggy recursive form', () => {
    // If we ever roll this hotfix back, we must NOT bring the
    // recursion bug back with us. Rolling back leaves user_roles
    // RLS at user_roles_read_own only — that's pre-PR-1 state and
    // is the safest rest position.
    expect(rollback).not.toMatch(/CREATE POLICY user_roles_admins_read_all/);
    expect(rollback).not.toMatch(/CREATE OR REPLACE FUNCTION public\.is_admin/);
  });
});
