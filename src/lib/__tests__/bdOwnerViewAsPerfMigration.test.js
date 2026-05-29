import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the RLS performance-hardening migration.
// Confirms is_owner() is wrapped in a scalar sub-select (once-per-query
// InitPlan) while remaining functionally identical to the original
// owner read-override (SELECT-only, write policies untouched).

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_PATH = join(
  __dirname,
  '../../../supabase/migrations/20260602020000_bd_owner_view_as_perf.sql',
);
const ROLLBACK_PATH = join(
  __dirname,
  '../../../supabase/migrations/_rollback/20260602020000_bd_owner_view_as_perf_down.sql',
);

const sql = readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

// Strip `-- ...` comment lines so assertions test the executable SQL,
// not the header prose (which references the old bare form on purpose).
const stripComments = (s) =>
  s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const sqlCode = stripComments(sql);

describe('bd_owner_view_as_perf migration', () => {
  it('wraps is_owner() in a scalar sub-select on both SELECT policies', () => {
    const matches = sql.match(/OR \(SELECT public\.is_owner\(\)\)/g) || [];
    expect(matches.length).toBe(2);
  });

  it('does not leave a bare is_owner() call in the executable SQL', () => {
    expect(sqlCode).not.toMatch(/OR public\.is_owner\(\)/);
  });

  it('only rewrites SELECT policies — no write-policy or schema changes', () => {
    expect(sql).not.toMatch(/FOR (INSERT|UPDATE|DELETE)/);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
    expect(sql).not.toMatch(/DELETE FROM/i);
  });

  it('is idempotent (DROP POLICY IF EXISTS before each CREATE)', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS "tenant_isolation_bd_account_stars_select"/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_select"/);
  });

  it('rollback restores the bare is_owner() form', () => {
    expect(rollback).toMatch(/OR public\.is_owner\(\)/);
    expect(rollback).not.toMatch(/OR \(SELECT public\.is_owner\(\)\)/);
  });
});
