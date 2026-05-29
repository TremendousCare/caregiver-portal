import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structural assertions on the restrict_caregiver_documents_to_admins
// migration. The migration's own DO sanity block is the runtime safety
// net (it confirms the RESTRICTIVE policy landed and aborts the deploy
// otherwise). This spec catches accidents in PR review — wrong policy
// mode (PERMISSIVE vs RESTRICTIVE), wrong role predicate (a bare 'admin'
// literal would lock owners out), dropping existing policies, or schema
// changes.

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/20260601020000_restrict_caregiver_documents_to_admin.sql'
);

const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/_rollback/20260601020000_restrict_caregiver_documents_to_admin_down.sql'
);

describe('restrict_caregiver_documents_to_admins migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8');
  const rollback = readFileSync(ROLLBACK_PATH, 'utf-8');

  it('targets the caregiver_documents table', () => {
    expect(sql).toMatch(
      /CREATE POLICY restrict_caregiver_documents_to_admins ON public\.caregiver_documents/
    );
  });

  it('creates a RESTRICTIVE policy (not permissive)', () => {
    // A PERMISSIVE policy would OR with the existing staff_all /
    // tenant_isolation policies and re-grant member access, defeating
    // the purpose. RESTRICTIVE ANDs, which is what we want.
    expect(sql).toMatch(/AS RESTRICTIVE/);
    expect(sql).not.toMatch(/AS PERMISSIVE/);
  });

  it('targets the authenticated role only', () => {
    expect(sql).toMatch(/TO authenticated/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO anon/);
    expect(sql).not.toMatch(/CREATE POLICY .* TO service_role/);
  });

  it('uses FOR ALL so SELECT/INSERT/UPDATE/DELETE are all gated', () => {
    expect(sql).toMatch(/FOR ALL/);
  });

  it('enforces both USING and WITH CHECK so writes cannot bypass', () => {
    expect(sql).toMatch(/USING\s*\(\s*public\.is_admin\(\)\s*\)/);
    expect(sql).toMatch(/WITH CHECK\s*\(\s*public\.is_admin\(\)\s*\)/);
  });

  it('gates on public.is_admin() so OWNERS are included, not a bare literal', () => {
    // is_admin() is true for 'admin' AND 'owner'. The older payroll
    // migration inlined `ur.role = 'admin'`, which predates the owner
    // tier and would silently lock owners out. Owners must keep access.
    expect(sql).toMatch(/public\.is_admin\(\)/);
    expect(sql).not.toMatch(/ur\.role = 'admin'/);
    expect(sql).not.toMatch(/role\s*=\s*'admin'/);
  });

  it('is idempotent — DROP POLICY IF EXISTS precedes CREATE POLICY', () => {
    expect(sql).toMatch(
      /DROP POLICY IF EXISTS restrict_caregiver_documents_to_admins ON public\.caregiver_documents/
    );
    const dropIdx = sql.indexOf('DROP POLICY IF EXISTS restrict_caregiver_documents_to_admins');
    const createIdx = sql.indexOf('CREATE POLICY restrict_caregiver_documents_to_admins');
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(dropIdx);
  });

  it('aborts the deploy if the RESTRICTIVE policy is not present', () => {
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/polpermissive = false/);
    expect(sql).toMatch(/p\.polname = 'restrict_caregiver_documents_to_admins'/);
  });

  it('does not modify or drop any existing policy', () => {
    // Prime directive: additive only. The existing staff_all and
    // tenant_isolation_* policies must remain untouched.
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS caregiver_documents_staff_all/);
    expect(sql).not.toMatch(/DROP POLICY IF EXISTS tenant_isolation/);
    expect(sql).not.toMatch(/ALTER POLICY/);
    expect(sql).not.toMatch(/DROP FUNCTION/);
  });

  it('does not alter table schema', () => {
    expect(sql).not.toMatch(/ALTER TABLE/);
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/CREATE TABLE/);
  });

  it('rollback drops only the new RESTRICTIVE policy and nothing else', () => {
    expect(rollback).toMatch(
      /DROP POLICY IF EXISTS restrict_caregiver_documents_to_admins ON public\.caregiver_documents/
    );
    // No collateral drops — the permissive policies stay in place so
    // org isolation and staff access are restored cleanly.
    expect(rollback).not.toMatch(/DROP POLICY[^;]*tenant_isolation/);
    expect(rollback).not.toMatch(/DROP POLICY[^;]*staff_all/);
    expect(rollback).not.toMatch(/DROP TABLE/);
    expect(rollback).not.toMatch(/CREATE POLICY/);
  });
});
