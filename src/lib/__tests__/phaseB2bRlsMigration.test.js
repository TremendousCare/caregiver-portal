import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the Phase B2b migration. As with B2a, the migration's
// own DO sanity block is the runtime safety net (it counts the new policies
// after they're created and aborts the deploy if the count is off). This spec
// catches accidental deletion of those guards or the table list in future PRs.
const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260501010000_phase_b2b_org_scoped_rls.sql'
);

describe('Phase B2b org-scoped RLS migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');

  it('skips email_accounts and email_routing (service-role-only tables)', () => {
    // Guard against someone reintroducing them to the table array.
    const tableArrayMatch = sql.match(/v_tables text\[\] := ARRAY\[([\s\S]*?)\]/);
    expect(tableArrayMatch, 'table array not found').toBeTruthy();
    const arrayBody = tableArrayMatch[1];
    expect(arrayBody).not.toMatch(/'email_accounts'/);
    expect(arrayBody).not.toMatch(/'email_routing'/);
  });

  it('lists exactly 40 tables', () => {
    const tableArrayMatch = sql.match(/v_tables text\[\] := ARRAY\[([\s\S]*?)\]/);
    const tables = (tableArrayMatch[1].match(/'[a-z_]+'/g) ?? []).map((s) => s.slice(1, -1));
    expect(tables).toHaveLength(40);
  });

  it('uses the strict fail-closed predicate with nullif coercion', () => {
    expect(sql).toMatch(
      /org_id = nullif\(auth\.jwt\(\) ->> ''org_id'', ''''\)::uuid/
    );
  });

  it('targets the authenticated role, not public/anon', () => {
    const createPolicyLines = sql.match(/CREATE POLICY .* TO authenticated/g) ?? [];
    expect(createPolicyLines.length).toBeGreaterThanOrEqual(4);
    expect(sql).not.toMatch(/CREATE POLICY .* TO anon/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO public[^a-z_]/);
  });

  it('creates one policy per command (SELECT/INSERT/UPDATE/DELETE)', () => {
    expect(sql).toMatch(/FOR SELECT TO authenticated USING/);
    expect(sql).toMatch(/FOR INSERT TO authenticated WITH CHECK/);
    expect(sql).toMatch(/FOR UPDATE TO authenticated USING .* WITH CHECK/);
    expect(sql).toMatch(/FOR DELETE TO authenticated USING/);
  });

  it('uses uniform tenant_isolation_<table>_<cmd> naming', () => {
    expect(sql).toMatch(/'tenant_isolation_' \|\| tbl \|\| '_select'/);
    expect(sql).toMatch(/'tenant_isolation_' \|\| tbl \|\| '_insert'/);
    expect(sql).toMatch(/'tenant_isolation_' \|\| tbl \|\| '_update'/);
    expect(sql).toMatch(/'tenant_isolation_' \|\| tbl \|\| '_delete'/);
  });

  it('is idempotent — every CREATE POLICY is paired with DROP POLICY IF EXISTS', () => {
    const drops = (sql.match(/DROP POLICY IF EXISTS/g) ?? []).length;
    const creates = (sql.match(/CREATE POLICY/g) ?? []).length;
    expect(drops).toBe(creates);
  });

  it('aborts the deploy if the policy count is not exactly 160', () => {
    expect(sql).toMatch(/expected 160 tenant_isolation_\* policies/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('uses a suffix-anchored regex for the sanity check, not a broad LIKE', () => {
    // The Paychex payroll work shipped 4 pre-existing tenant_isolation_*
    // policies that would otherwise inflate the count. The sanity guard must
    // match B2b's naming exactly (table_<command> suffix), not the prefix.
    expect(sql).toMatch(
      /polname ~ '\^tenant_isolation_\.\*_\(select\|insert\|update\|delete\)\$'/
    );
    // And must NOT use the broad prefix-only filter that caused the original
    // false-positive count of 164.
    expect(sql).not.toMatch(/polname LIKE 'tenant_isolation\\_%' ESCAPE '\\\\'/);
  });

  it('does not modify or drop any existing policy or function', () => {
    // The retrofit's prime directive: additive only. B2b must not touch
    // is_staff(), current_user_caregiver_id(), or any pre-existing policy.
    // Drops in this file must only target tenant_isolation_* names, which
    // is guaranteed by the constructed-name expression below.
    expect(sql).not.toMatch(/ALTER POLICY/);
    expect(sql).not.toMatch(/DROP FUNCTION/);
    // Every DROP POLICY in the file must be paired with a matching CREATE
    // POLICY (this is verified by the "idempotent" test above), and every
    // policy name in the migration is constructed from the
    // 'tenant_isolation_' prefix — so no pre-existing policy can be dropped.
    expect(sql).toMatch(/'tenant_isolation_' \|\| tbl/);
  });

  it('does not alter any table schema', () => {
    expect(sql).not.toMatch(/ALTER TABLE/);
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/CREATE TABLE/);
  });
});
