/**
 * Phase 1.6.1 — call_taxonomy table migration.
 *
 * Structural assertions on the migration SQL. Runtime semantics
 * (cross-tenant RLS, RPC behaviour, REVOKE effect) are verified in
 * the Supabase SQL editor pre-merge per CLAUDE.md → RLS Safety.
 *
 * Mirrors the assertion style used by `bdTerritoriesMigration.test.js`
 * + `phase05PrBMigration.test.js` for table-write-lockdown.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260516010000_agent_platform_phase_1_6_1_call_taxonomy_table.sql',
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260516010000_agent_platform_phase_1_6_1_call_taxonomy_table_down.sql',
);

const sql      = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('call_taxonomy migration — schema', () => {
  it('creates the table idempotently', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.call_taxonomy/);
  });

  it('declares org_id NOT NULL with default_org_id() default + FK to organizations', () => {
    expect(sql).toMatch(
      /org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)[\s\S]*?REFERENCES public\.organizations\(id\)/,
    );
  });

  it('locks the axis CHECK to call_type | red_flag', () => {
    expect(sql).toMatch(/axis\s+text NOT NULL CHECK \(axis IN \('call_type', 'red_flag'\)\)/);
  });

  it('requires non-empty slug + label', () => {
    expect(sql).toMatch(/slug\s+text NOT NULL CHECK \(length\(slug\) > 0\)/);
    expect(sql).toMatch(/label\s+text NOT NULL CHECK \(length\(label\) > 0\)/);
  });

  it('defaults sort_order to 0 and is_active to true', () => {
    expect(sql).toMatch(/sort_order\s+integer NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/is_active\s+boolean NOT NULL DEFAULT true/);
  });

  it('enforces uniqueness on (org_id, axis, slug)', () => {
    expect(sql).toMatch(/UNIQUE \(org_id, axis, slug\)/);
  });

  it('creates the per-axis sort index', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_call_taxonomy_org_axis_sort[\s\S]*?\(org_id, axis, sort_order, created_at\)/,
    );
  });

  it('creates the active-only partial index', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_call_taxonomy_org_axis_active[\s\S]*?\(org_id, axis, sort_order\)\s+WHERE is_active = true/,
    );
  });

  it('attaches the touch_updated_at trigger', () => {
    expect(sql).toMatch(/CREATE TRIGGER call_taxonomy_set_updated_at[\s\S]*?EXECUTE FUNCTION public\.touch_updated_at\(\)/);
  });
});

describe('call_taxonomy migration — RLS + lockdown', () => {
  it('enables row level security', () => {
    expect(sql).toMatch(/ALTER TABLE public\.call_taxonomy ENABLE ROW LEVEL SECURITY/);
  });

  it('ships exactly one SELECT policy gated on JWT org_id', () => {
    expect(sql).toMatch(/CREATE POLICY tenant_isolation_call_taxonomy_select ON public\.call_taxonomy/);
    expect(sql).toMatch(/auth\.jwt\(\) ->> ''org_id''/);
    // No INSERT/UPDATE/DELETE policies for authenticated.
    expect(sql).not.toMatch(/FOR INSERT TO authenticated/);
    expect(sql).not.toMatch(/FOR UPDATE TO authenticated/);
    expect(sql).not.toMatch(/FOR DELETE TO authenticated/);
  });

  it('grants service_role full access via policy', () => {
    expect(sql).toMatch(/CREATE POLICY service_role_full_access_call_taxonomy ON public\.call_taxonomy[\s\S]*?TO service_role/);
  });

  it('revokes INSERT/UPDATE/DELETE from authenticated (write lockdown)', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.call_taxonomy FROM authenticated/);
  });

  it('fails the migration if the lockdown REVOKE did not land', () => {
    // The DO block at the bottom of the migration runs a sanity check.
    expect(sql).toMatch(/call_taxonomy lockdown failed/);
    expect(sql).toMatch(/privilege_type IN \('INSERT', 'UPDATE', 'DELETE'\)/);
  });
});

describe('call_taxonomy rollback', () => {
  it('drops the table with CASCADE', () => {
    expect(rollback).toMatch(/DROP TABLE IF EXISTS public\.call_taxonomy CASCADE/);
  });
});
