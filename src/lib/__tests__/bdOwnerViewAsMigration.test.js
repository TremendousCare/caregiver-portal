import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the bd_owner_view_as migration. Runtime RLS
// semantics (does an owner actually see Amy's stars? does a member get
// []?) must be verified in the Supabase SQL editor pre-merge per
// CLAUDE.md → RLS Safety; these tests guard the shape of the SQL so a
// careless edit can't silently drop the owner branch or a GRANT.

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260602000000_bd_owner_view_as.sql',
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260602000000_bd_owner_view_as_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('bd_owner_view_as migration — owner read-override policies', () => {
  it('rewrites the bd_account_stars SELECT policy with an is_owner() branch', () => {
    expect(sql).toMatch(
      /CREATE POLICY "tenant_isolation_bd_account_stars_select"[\s\S]*?FOR SELECT[\s\S]*?user_id = \(SELECT auth\.uid\(\)\)[\s\S]*?OR public\.is_owner\(\)/,
    );
  });

  it('rewrites the bd_mileage_entries SELECT policy with an is_owner() branch', () => {
    expect(sql).toMatch(
      /CREATE POLICY "tenant_isolation_bd_mileage_entries_select"[\s\S]*?FOR SELECT[\s\S]*?user_id = \(SELECT auth\.uid\(\)\)[\s\S]*?OR public\.is_owner\(\)/,
    );
  });

  it('keeps both SELECT policies org-scoped (fail-closed on org_id)', () => {
    const matches = sql.match(/org_id = nullif\(\(SELECT auth\.jwt\(\)\) ->> 'org_id', ''\)::uuid/g) || [];
    // Two SELECT policies + two RPC bodies reference the org claim.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT grant owners any write override (no is_owner on INSERT/UPDATE/DELETE)', () => {
    // The migration must only touch the SELECT policies. Guard against a
    // future edit that copies the is_owner branch into a write policy.
    expect(sql).not.toMatch(/FOR (INSERT|UPDATE|DELETE)/);
  });
});

describe('bd_owner_view_as migration — RPCs', () => {
  it('defines bd_territory_cities_for_user as STABLE SECURITY DEFINER with a pinned search_path', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.bd_territory_cities_for_user\(p_user_id uuid\)[\s\S]*?STABLE[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = public/,
    );
  });

  it('gates the territory RPC on self-or-owner', () => {
    expect(sql).toMatch(
      /p_user_id = \(SELECT auth\.uid\(\)\) OR public\.is_owner\(\)/,
    );
  });

  it('defines bd_list_auditable_reps as STABLE SECURITY DEFINER returning the rep columns', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.bd_list_auditable_reps\(\)[\s\S]*?RETURNS TABLE \(user_id uuid, email text, full_name text\)[\s\S]*?SECURITY DEFINER/,
    );
  });

  it('gates the rep list on is_owner() and excludes the caller', () => {
    expect(sql).toMatch(/m\.user_id <> \(SELECT auth\.uid\(\)\)/);
    expect(sql).toMatch(/AND public\.is_owner\(\)/);
  });

  it('locks down EXECUTE: REVOKE from PUBLIC, GRANT to authenticated', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.bd_territory_cities_for_user\(uuid\) FROM PUBLIC/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.bd_territory_cities_for_user\(uuid\) TO authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.bd_list_auditable_reps\(\) FROM PUBLIC/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.bd_list_auditable_reps\(\) TO authenticated/);
  });
});

describe('bd_owner_view_as migration — production safety', () => {
  it('is idempotent: DROP POLICY IF EXISTS before each rewritten policy', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS "tenant_isolation_bd_account_stars_select"/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_select"/);
  });

  it('makes no destructive schema changes (no DROP TABLE / DELETE FROM / ALTER TABLE)', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
  });

  it('ships a deploy-time sanity DO block', () => {
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*?bd_owner_view_as/);
  });
});

describe('bd_owner_view_as rollback', () => {
  it('restores both SELECT policies to self-only (no is_owner)', () => {
    expect(rollback).toMatch(/CREATE POLICY "tenant_isolation_bd_account_stars_select"/);
    expect(rollback).toMatch(/CREATE POLICY "tenant_isolation_bd_mileage_entries_select"/);
    expect(rollback).not.toMatch(/is_owner/);
  });

  it('drops both RPCs', () => {
    expect(rollback).toMatch(/DROP FUNCTION IF EXISTS public\.bd_territory_cities_for_user\(uuid\)/);
    expect(rollback).toMatch(/DROP FUNCTION IF EXISTS public\.bd_list_auditable_reps\(\)/);
  });
});
