import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the bd_route_plans migration. Runtime
// semantics (RLS isolation, partial-index conflict behavior, FK
// cascade from auth.users delete) are verified manually pre-merge per
// CLAUDE.md → RLS Safety.

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260513150000_bd_route_plans.sql'
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260513150000_bd_route_plans_down.sql'
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

describe('bd_route_plans migration — schema', () => {
  it('creates the table with the canonical column set', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bd_route_plans/);
    expect(sql).toMatch(/plan_date\s+date NOT NULL/);
    expect(sql).toMatch(/stops\s+jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
    expect(sql).toMatch(/status\s+text NOT NULL DEFAULT 'active'/);
  });

  it('declares org_id NOT NULL with default_org_id() default and FK to organizations', () => {
    expect(sql).toMatch(
      /org_id\s+uuid NOT NULL DEFAULT public\.default_org_id\(\)[\s\S]*?REFERENCES organizations\(id\)/
    );
  });

  it('declares owner_user_id NOT NULL with FK to auth.users ON DELETE CASCADE', () => {
    expect(sql).toMatch(
      /owner_user_id\s+uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/
    );
  });

  it('constrains status to active/archived (no soft-delete needed; archived rows survive)', () => {
    expect(sql).toMatch(/CHECK \(status IN \('active', 'archived'\)\)/);
  });

  it('constrains stops to a JSONB array', () => {
    expect(sql).toMatch(/CHECK \(jsonb_typeof\(stops\) = 'array'\)/);
  });

  it('enforces one active plan per (org, user, plan_date) via a partial unique index', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS bd_route_plans_active_per_day[\s\S]*?\(org_id, owner_user_id, plan_date\)[\s\S]*?WHERE status = 'active'/
    );
  });

  it('enables RLS', () => {
    expect(sql).toMatch(/ALTER TABLE bd_route_plans ENABLE ROW LEVEL SECURITY/);
  });

  it('ships the four tenant_isolation policies that gate on org match AND (owner OR admin)', () => {
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      expect(sql).toMatch(
        new RegExp(`CREATE POLICY "tenant_isolation_bd_route_plans_${cmd}"`)
      );
    }
    // Every user policy must include the owner-or-admin clause —
    // otherwise reps could read each other's plans.
    const ownerOrAdminClauses = sql.match(/owner_user_id = auth\.uid\(\) OR public\.is_admin\(\)/g) ?? [];
    expect(ownerOrAdminClauses.length).toBeGreaterThanOrEqual(4);
  });

  it('grants service_role full access for cron + admin tasks', () => {
    expect(sql).toMatch(/CREATE POLICY "service_role_full_access_bd_route_plans"[\s\S]*?TO service_role/);
  });

  it('attaches the touch_updated_at trigger', () => {
    expect(sql).toMatch(/CREATE TRIGGER bd_route_plans_set_updated_at/);
    expect(sql).toMatch(/EXECUTE FUNCTION public\.touch_updated_at\(\)/);
  });

  it('is replayable (IF NOT EXISTS / DROP POLICY IF EXISTS throughout)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bd_route_plans/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS bd_route_plans_active_per_day/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "tenant_isolation_bd_route_plans_select"/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS bd_route_plans_set_updated_at/);
  });

  it('does NOT contain destructive statements against existing data', () => {
    // Strip SQL comments before checking so docstring references like
    // "no DROP TABLE" in the migration header don't trip the regex.
    // ON DELETE CASCADE is benign here — controls cascade behavior of
    // bd_route_plans rows when their owner user is deleted, never of
    // pre-existing data.
    const stripped = sql.replace(/--[^\n]*/g, '');
    expect(stripped).not.toMatch(/\bDROP TABLE\b/);
    expect(stripped).not.toMatch(/\bDELETE FROM\b/);
    expect(stripped).not.toMatch(/\bTRUNCATE\b/);
  });
});

describe('bd_route_plans migration — rollback', () => {
  it('drops the table', () => {
    expect(rollback).toMatch(/DROP TABLE IF EXISTS bd_route_plans/);
  });
});
