import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the bd_territories migration. Runtime
// semantics (RLS isolation, FK cascade, RPC return type) are verified
// in the Supabase SQL editor pre-merge per CLAUDE.md → RLS Safety.

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260513140000_bd_territories_and_strategic_flag.sql'
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260513140000_bd_territories_and_strategic_flag_down.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('bd_territories + strategic-flag migration — schema', () => {
  describe('bd_accounts.is_strategic_shared', () => {
    it('adds the column as NOT NULL DEFAULT false', () => {
      expect(sql).toMatch(
        /ALTER TABLE bd_accounts\s+ADD COLUMN IF NOT EXISTS is_strategic_shared boolean NOT NULL DEFAULT false/
      );
    });
  });

  describe('bd_territories', () => {
    it('creates the table with the canonical column set', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bd_territories/);
      expect(sql).toMatch(/cities\s+text\[\]\s+NOT NULL/);
      expect(sql).toMatch(/name\s+text NOT NULL/);
    });

    it('declares org_id NOT NULL with the default_org_id() default and FK to organizations', () => {
      // Matches whether or not extra whitespace is inserted between tokens.
      expect(sql).toMatch(
        /org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)[\s\S]*?REFERENCES organizations\(id\)/
      );
    });

    it('enables RLS and ships the four tenant_isolation policies', () => {
      expect(sql).toMatch(/ALTER TABLE bd_territories ENABLE ROW LEVEL SECURITY/);
      for (const cmd of ['select', 'insert', 'update', 'delete']) {
        expect(sql).toMatch(
          new RegExp(`CREATE POLICY "tenant_isolation_bd_territories_${cmd}"`)
        );
      }
    });

    it('grants service_role full access', () => {
      expect(sql).toMatch(/CREATE POLICY "service_role_full_access_bd_territories"/);
      expect(sql).toMatch(
        /CREATE POLICY "service_role_full_access_bd_territories"[\s\S]*?TO service_role/
      );
    });

    it('attaches the touch_updated_at trigger', () => {
      expect(sql).toMatch(/CREATE TRIGGER bd_territories_set_updated_at/);
      expect(sql).toMatch(/EXECUTE FUNCTION public\.touch_updated_at\(\)/);
    });

    it('declares a unique index on (org_id, lower(name))', () => {
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS bd_territories_org_name_unique[\s\S]*?\(org_id, lower\(name\)\)/
      );
    });
  });

  describe('bd_territory_members', () => {
    it('creates the join table with a composite PK and FK to auth.users', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bd_territory_members/);
      expect(sql).toMatch(/PRIMARY KEY \(territory_id, user_id\)/);
      expect(sql).toMatch(/REFERENCES auth\.users\(id\)\s+ON DELETE CASCADE/);
    });

    it('carries its own org_id (denormalized to keep RLS leaf-level)', () => {
      // The RLS-gotchas doc says subquerying the parent table from a
      // child policy is the path to recursion. This test fails if a
      // future contributor "cleans up" the duplication by removing
      // the column.
      expect(sql).toMatch(
        /CREATE TABLE IF NOT EXISTS bd_territory_members[\s\S]*?org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)/
      );
    });

    it('cascades when the parent territory is deleted', () => {
      expect(sql).toMatch(
        /territory_id uuid NOT NULL REFERENCES bd_territories\(id\)\s+ON DELETE CASCADE/
      );
    });

    it('enables RLS and ships the four tenant_isolation policies', () => {
      expect(sql).toMatch(/ALTER TABLE bd_territory_members ENABLE ROW LEVEL SECURITY/);
      for (const cmd of ['select', 'insert', 'update', 'delete']) {
        expect(sql).toMatch(
          new RegExp(`CREATE POLICY "tenant_isolation_bd_territory_members_${cmd}"`)
        );
      }
    });
  });

  describe('bd_current_user_territory_cities RPC', () => {
    it('is declared STABLE SECURITY DEFINER with an explicit search_path', () => {
      expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.bd_current_user_territory_cities\(\)/);
      expect(sql).toMatch(/SECURITY DEFINER/);
      expect(sql).toMatch(/SET search_path = public/);
      expect(sql).toMatch(/STABLE/);
    });

    it('returns a text[]', () => {
      expect(sql).toMatch(/RETURNS text\[\]/);
    });

    it('scopes by both auth.uid() AND the JWT org_id (defense in depth)', () => {
      expect(sql).toMatch(/WHERE m\.user_id = auth\.uid\(\)/);
      expect(sql).toMatch(/m\.org_id\s+=\s+nullif\(\(SELECT auth\.jwt\(\)\)\s+->>\s+'org_id'/);
    });

    it('grants execute to authenticated', () => {
      expect(sql).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.bd_current_user_territory_cities\(\) TO authenticated/
      );
    });
  });

  describe('safety / idempotency', () => {
    it('uses IF NOT EXISTS / IF EXISTS so the deploy workflow can replay it', () => {
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS is_strategic_shared/);
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bd_territories/);
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bd_territory_members/);
      // Policies are guarded by DROP POLICY IF EXISTS before CREATE.
      expect(sql).toMatch(/DROP POLICY IF EXISTS "tenant_isolation_bd_territories_select" ON bd_territories/);
    });

    it('does NOT contain destructive statements against existing data', () => {
      // Match SQL statements, not the substring ("ON DELETE CASCADE"
      // in FK declarations is benign — it controls cascade behavior
      // for the new bd_territory_members rows, not the parent rows).
      expect(sql).not.toMatch(/\bDROP TABLE\b/);
      expect(sql).not.toMatch(/\bDELETE FROM\b/);
      expect(sql).not.toMatch(/\bTRUNCATE\b/);
      // ALTER bd_accounts is bounded to the additive column add.
      const alters = sql.match(/ALTER TABLE [a-z_]+/g) ?? [];
      const nonAdditive = alters.filter((a) => a !== 'ALTER TABLE bd_accounts' && a !== 'ALTER TABLE bd_territories' && a !== 'ALTER TABLE bd_territory_members');
      expect(nonAdditive).toEqual([]);
    });
  });
});

describe('bd_territories + strategic-flag migration — rollback', () => {
  it('drops both tables and the strategic-flag column', () => {
    expect(rollback).toMatch(/DROP TABLE IF EXISTS bd_territory_members/);
    expect(rollback).toMatch(/DROP TABLE IF EXISTS bd_territories/);
    expect(rollback).toMatch(/ALTER TABLE bd_accounts DROP COLUMN IF EXISTS is_strategic_shared/);
  });

  it('drops the helper RPC', () => {
    expect(rollback).toMatch(/DROP FUNCTION IF EXISTS public\.bd_current_user_territory_cities/);
  });
});
