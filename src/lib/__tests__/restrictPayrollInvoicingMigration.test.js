import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the restrict_*_to_admins migration.
// The migration's own DO sanity block is the runtime safety net (it
// counts the new policies after CREATE and aborts the deploy if the
// count is off). This spec catches accidents in PR review — wrong
// table list, wrong policy mode (RESTRICTIVE vs PERMISSIVE), wrong
// role grant, or filter regression.

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260509000001_restrict_payroll_invoicing_to_admins.sql'
);

const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260509000001_restrict_payroll_invoicing_to_admins_down.sql'
);

const EXPECTED_TABLES = [
  'invoices',
  'invoice_shifts',
  'invoice_runs',
  'timesheets',
  'timesheet_shifts',
  'payroll_runs',
  'paychex_api_log',
];

describe('restrict_*_to_admins migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');
  const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

  it('lists exactly the 7 expected tables', () => {
    const tableArrayMatch = sql.match(/v_tables text\[\] := ARRAY\[([\s\S]*?)\]/);
    expect(tableArrayMatch, 'table array not found').toBeTruthy();
    const tables = (tableArrayMatch[1].match(/'[a-z_]+'/g) ?? []).map(
      (s) => s.slice(1, -1)
    );
    expect(tables).toEqual(EXPECTED_TABLES);
  });

  it('creates RESTRICTIVE policies (not permissive)', () => {
    // PERMISSIVE policies would OR with the existing tenant_isolation_*
    // policies and effectively re-grant access — defeating the purpose
    // of this migration. RESTRICTIVE ANDs, which is what we want.
    expect(sql).toMatch(/AS RESTRICTIVE/);
    expect(sql).not.toMatch(/AS PERMISSIVE/);
  });

  it('targets the authenticated role only', () => {
    expect(sql).toMatch(/TO authenticated/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO anon/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO public[^.]/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO service_role/);
  });

  it('uses FOR ALL so SELECT/INSERT/UPDATE/DELETE are all gated', () => {
    expect(sql).toMatch(/FOR ALL/);
    expect(sql).not.toMatch(/FOR SELECT[\s\n]/);
  });

  it('enforces both USING and WITH CHECK so writes cannot bypass', () => {
    // Without WITH CHECK, INSERT/UPDATE could still write rows that
    // the caller would not be able to read back — surprising and
    // unsafe. Both clauses use the same admin predicate.
    expect(sql).toMatch(/USING\s*\(/);
    expect(sql).toMatch(/WITH CHECK\s*\(/);
  });

  it('gates on user_roles.role = admin via EXISTS lookup', () => {
    // Match the predicate every other admin policy in the codebase
    // already uses (automation_rules, message_templates, etc.). When
    // Phase B5 migrates to JWT org_role, all such predicates change
    // together in one coordinated PR.
    expect(sql).toMatch(
      /EXISTS\s*\(\s*\n?\s*SELECT 1 FROM public\.user_roles ur/
    );
    expect(sql).toMatch(/ur\.role = 'admin'/);
    expect(sql).toMatch(
      /ur\.email = lower\(\(SELECT auth\.jwt\(\)\) ->> 'email'\)/
    );
  });

  it('uses uniform restrict_<table>_to_admins naming', () => {
    expect(sql).toMatch(/'restrict_' \|\| tbl \|\| '_to_admins'/);
  });

  it('is idempotent — DROP POLICY IF EXISTS precedes CREATE POLICY', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS/);
    // Both DROP and CREATE are inside the loop; one of each per table.
    const drops = (sql.match(/DROP POLICY IF EXISTS/g) ?? []).length;
    const creates = (sql.match(/CREATE POLICY/g) ?? []).length;
    expect(drops).toBe(creates);
  });

  it('aborts the deploy if the policy count is not exactly 7', () => {
    expect(sql).toMatch(/expected 7 restrict_\*_to_admins/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('uses a suffix-anchored regex for the sanity check, not broad LIKE', () => {
    // Lessons-locked from the B2b hotfix: a prefix-only filter
    // ('restrict_%') would falsely match unrelated future restrict_*
    // policies. Anchor on the _to_admins suffix.
    expect(sql).toMatch(/polname ~ '\^restrict_\.\*_to_admins\$'/);
    expect(sql).not.toMatch(/polname LIKE 'restrict\\_%'/);
  });

  it('filters the sanity count to RESTRICTIVE policies only', () => {
    // Any future permissive policy named restrict_<table>_to_admins
    // (unlikely but possible) must not satisfy the count check —
    // the whole point is that these be RESTRICTIVE.
    expect(sql).toMatch(/polpermissive = false/);
  });

  it('does not modify or drop any existing tenant_isolation policy', () => {
    // The retrofit's prime directive: additive only. The existing
    // tenant_isolation_* policies must continue to enforce org scope.
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS tenant_isolation/);
    expect(sql).not.toMatch(/ALTER POLICY/);
    expect(sql).not.toMatch(/DROP FUNCTION/);
  });

  it('does not alter table schema', () => {
    expect(sql).not.toMatch(/ALTER TABLE/);
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/CREATE TABLE/);
  });

  it('rollback drops exactly the 7 new policies and nothing else', () => {
    EXPECTED_TABLES.forEach((tbl) => {
      const re = new RegExp(
        `DROP POLICY IF EXISTS restrict_${tbl}_to_admins\\s+ON public\\.${tbl}`
      );
      expect(rollback).toMatch(re);
    });
    // No tenant_isolation drops in the rollback — those policies
    // stay in place so org isolation is never weakened.
    expect(rollback).not.toMatch(/DROP POLICY[^;]*tenant_isolation/);
    expect(rollback).not.toMatch(/DROP POLICY[^;]*service_role/);
  });
});
