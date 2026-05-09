import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the second user_roles recursion hotfix.
// The migration's own DO sanity block is the runtime safety net (it
// reads the deployed predicate text from pg_policy and asserts both
// new policies reference is_admin()). This spec catches accidental
// regressions in PR review — most importantly, anyone re-introducing
// the inline EXISTS pattern that caused the original incident.

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260509110000_fix_user_roles_update_insert_recursion.sql'
);
const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260509110000_fix_user_roles_update_insert_recursion_down.sql'
);

describe('user_roles UPDATE/INSERT recursion hotfix', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');
  const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

  it('drops both target policies before recreating them', () => {
    const dropUpdateIdx = sql.indexOf(
      'DROP POLICY IF EXISTS admins_update_user_roles'
    );
    const createUpdateIdx = sql.indexOf(
      'CREATE POLICY admins_update_user_roles'
    );
    const dropInsertIdx = sql.indexOf(
      'DROP POLICY IF EXISTS user_roles_admins_insert'
    );
    const createInsertIdx = sql.indexOf(
      'CREATE POLICY user_roles_admins_insert'
    );
    expect(dropUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(createUpdateIdx).toBeGreaterThan(dropUpdateIdx);
    expect(dropInsertIdx).toBeGreaterThanOrEqual(0);
    expect(createInsertIdx).toBeGreaterThan(dropInsertIdx);
  });

  it('UPDATE policy delegates to public.is_admin() in both USING and WITH CHECK', () => {
    expect(sql).toMatch(
      /CREATE POLICY admins_update_user_roles ON public\.user_roles[\s\S]*?USING \(public\.is_admin\(\)\)[\s\S]*?WITH CHECK \(public\.is_admin\(\)\)/
    );
  });

  it('INSERT policy delegates to public.is_admin() in WITH CHECK', () => {
    expect(sql).toMatch(
      /CREATE POLICY user_roles_admins_insert ON public\.user_roles[\s\S]*?WITH CHECK \(public\.is_admin\(\)\)/
    );
  });

  it('neither new policy contains the inline EXISTS pattern', () => {
    // Guard against regression — the inline subquery is what caused
    // the recursion when chained from UPDATE/INSERT through SELECT-RLS.
    // Match each CREATE POLICY block individually and assert it doesn't
    // contain the recursive predicate. We don't sweep the whole file
    // because the file's *comments* legitimately describe the bug.
    const blocks = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block).not.toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(public\.)?user_roles/i);
    }
  });

  it('targets only the authenticated role', () => {
    expect(sql).toMatch(/FOR UPDATE[\s\n]+TO authenticated/);
    expect(sql).toMatch(/FOR INSERT[\s\n]+TO authenticated/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO anon/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO public[^.]/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO service_role/);
  });

  it('aborts the deploy if either new policy is missing post-create', () => {
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/admins_update_user_roles policy missing/);
    expect(sql).toMatch(/user_roles_admins_insert policy missing/);
  });

  it("aborts the deploy if either new policy doesn't reference is_admin()", () => {
    // This is the regression guard that the structural test couldn't
    // give us: the migration reads back the actual deployed predicate
    // text from pg_policy and asserts it contains is_admin(). If a
    // future migration silently replaces the predicate with an inline
    // EXISTS, this DO block aborts the deploy with a clear message.
    expect(sql).toMatch(/admins_update_user_roles USING does not reference is_admin\(\)/);
    expect(sql).toMatch(
      /user_roles_admins_insert WITH CHECK does not reference is_admin\(\)/
    );
  });

  it('does not modify or drop user_roles_read_own or user_roles_admins_read_all', () => {
    expect(sql).not.toMatch(/DROP POLICY[^;]*user_roles_read_own/);
    expect(sql).not.toMatch(/DROP POLICY[^;]*user_roles_admins_read_all/);
    expect(sql).not.toMatch(/ALTER POLICY[^;]*user_roles_read_own/);
    expect(sql).not.toMatch(/ALTER POLICY[^;]*user_roles_admins_read_all/);
  });

  it('does not redefine public.is_admin()', () => {
    // is_admin() is owned by the previous hotfix migration. This
    // migration should consume it, not redefine it.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.is_admin/);
    expect(sql).not.toMatch(/CREATE FUNCTION public\.is_admin/);
    expect(sql).not.toMatch(/DROP FUNCTION[^;]*is_admin/);
  });

  it('does not alter user_roles table schema', () => {
    expect(sql).not.toMatch(/ALTER TABLE.*user_roles/);
    expect(sql).not.toMatch(/DROP TABLE.*user_roles/);
    expect(sql).not.toMatch(/CREATE TABLE.*user_roles/);
  });

  it('rollback drops both new policies and does not recreate the buggy form', () => {
    expect(rollback).toMatch(
      /DROP POLICY IF EXISTS admins_update_user_roles ON public\.user_roles/
    );
    expect(rollback).toMatch(
      /DROP POLICY IF EXISTS user_roles_admins_insert ON public\.user_roles/
    );
    // Must not bring the recursion bug back as part of rollback.
    expect(rollback).not.toMatch(/CREATE POLICY admins_update_user_roles/);
    expect(rollback).not.toMatch(/CREATE POLICY user_roles_admins_insert/);
    expect(rollback).not.toMatch(
      /EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(public\.)?user_roles/i
    );
  });
});
