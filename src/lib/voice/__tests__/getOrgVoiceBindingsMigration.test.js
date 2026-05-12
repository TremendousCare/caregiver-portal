/**
 * Structural assertions on the get_org_voice_bindings RPC migration.
 * The migration's own DO block aborts if the function is missing.
 * This spec catches accidental removal of the auth gate, the
 * SECURITY DEFINER attributes, or the locked search_path in future
 * PRs — same shape as the other migration shape tests in this repo.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../supabase/migrations/20260512010000_voice_get_org_voice_bindings_rpc.sql',
);

describe('Voice Phase 1 PR 3 — get_org_voice_bindings RPC migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('defines public.get_org_voice_bindings()', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_org_voice_bindings\(\)/);
  });

  it('is STABLE SECURITY DEFINER with a locked search_path (RLS_GOTCHAS pattern)', () => {
    expect(sql).toMatch(/STABLE/);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path TO 'public'/);
  });

  it('returns the expected columns', () => {
    expect(sql).toMatch(/user_id\s+uuid/);
    expect(sql).toMatch(/email\s+text/);
    expect(sql).toMatch(/display_name\s+text/);
    expect(sql).toMatch(/role\s+text/);
    expect(sql).toMatch(/ringcentral_extension_id\s+text/);
  });

  it('gates the body on public.is_admin() so non-admins get no rows', () => {
    expect(sql).toMatch(/AND public\.is_admin\(\)/);
  });

  it('scopes by the JWT org_id claim (fail-closed on missing claim)', () => {
    expect(sql).toMatch(
      /om\.org_id\s*=\s*nullif\(\(auth\.jwt\(\) ->> 'org_id'\), ''\)::uuid/,
    );
  });

  it('restricts results to staff roles only', () => {
    expect(sql).toMatch(/om\.role IN \('admin', 'member'\)/);
  });

  it('grants execute to authenticated', () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_org_voice_bindings\(\) TO authenticated/,
    );
  });

  it('has a sanity DO block that aborts on missing function', () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/get_org_voice_bindings RPC missing/);
  });
});
