/**
 * Structural assertions on the admin UPDATE RLS migration for
 * org_memberships. Without this policy, the Voice & Calls admin
 * panel's "Save" silently no-ops (RLS denies the UPDATE, Supabase
 * returns zero-rows-affected as success).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260513020000_voice_phase1_org_memberships_admin_update.sql',
);

describe('Voice Phase 1 PR 3.4 — admin UPDATE policy on org_memberships', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('creates an UPDATE policy named admins_update_org_memberships', () => {
    expect(sql).toMatch(/CREATE POLICY "admins_update_org_memberships"/);
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/TO authenticated/);
  });

  it('gates the policy on public.is_admin() in both USING and WITH CHECK (RLS_GOTCHAS rule 1)', () => {
    // Two occurrences expected: once for USING, once for WITH CHECK.
    const adminCalls = sql.match(/public\.is_admin\(\)/g) ?? [];
    expect(adminCalls.length).toBeGreaterThanOrEqual(2);
    // No inline EXISTS against role tables — must use the helper.
    expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT[^)]*FROM\s+user_roles/i);
  });

  it('scopes by JWT org_id claim (fail-closed on missing claim)', () => {
    expect(sql).toMatch(
      /org_id\s*=\s*nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/,
    );
  });

  it('contains a sanity DO block that aborts if the policy is missing or wrong', () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(/admins_update_org_memberships policy missing/);
    expect(sql).toMatch(/USING does not reference is_admin\(\)/);
    expect(sql).toMatch(/WITH CHECK does not reference is_admin\(\)/);
  });
});
