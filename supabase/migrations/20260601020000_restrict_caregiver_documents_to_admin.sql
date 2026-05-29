-- ═══════════════════════════════════════════════════════════════
-- Restrict caregiver_documents to admin/owner (not member)
--
-- Goal: 'member' staff in the same org as an admin must NOT be able to
-- read (or write) caregiver documents. These rows index payroll/tax PII
-- (I-9, W-4, direct deposit authorizations, signed employment
-- agreements). admin and owner staff retain full access; members lose
-- the Documents section entirely (the UI also hides it for non-admins).
--
-- Why a role check is required
-- ────────────────────────────
-- caregiver_documents already has two PERMISSIVE policies that 'member'
-- satisfies, and permissive policies OR together:
--   * caregiver_documents_staff_all  — USING public.is_staff()  (member ✓)
--   * tenant_isolation_caregiver_documents_select (+ ins/upd/del) — org_id
--     only, NO role check at all
-- Tightening either one alone leaves the other granting access.
--
-- Approach: a single RESTRICTIVE policy. Postgres ANDs RESTRICTIVE
-- policies with the permissive ones, so the effective rule becomes:
--   final = (existing permissive grant) AND (caller is admin/owner)
-- This is purely additive — no existing policy is modified or dropped —
-- and the rollback removes this one policy to fully revert the PR. Same
-- pattern as 20260509000001_restrict_payroll_invoicing_to_admins.
--
-- Role predicate: public.is_admin(), which is true for 'admin' AND
-- 'owner' (owners are admins, hierarchically — see roles.js / is_admin()).
-- We deliberately do NOT inline a bare role-literal predicate like the
-- older payroll migration: that approach predates the 'owner' tier
-- (added 20260528) and would silently lock owners out. is_admin() is STABLE
-- SECURITY DEFINER and reads user_roles — one level into a DIFFERENT
-- table, so there is no policy-recursion risk on caregiver_documents
-- (the canonical pattern documented in docs/RLS_GOTCHAS.md).
--
-- Service role: unaffected. service_role bypasses RLS at the postgres
-- layer, so both edge functions (sharepoint-docs, caregiver-doc-upload)
-- and the public token-based self-service caregiver upload continue to
-- work unchanged. The staff frontend never writes to caregiver_documents
-- directly (all writes go through service-role edge functions), so
-- gating writes to admin too has no functional impact — it is
-- defense-in-depth and keeps the policy set coherent.
--
-- Production safety:
--   - Pure additive; no existing policy modified or dropped; no DDL.
--   - Idempotent (DROP POLICY IF EXISTS + CREATE).
--   - Sanity DO block aborts the deploy if the policy is missing or not
--     RESTRICTIVE after CREATE.
--
-- Rollback: _rollback/20260601020000_restrict_caregiver_documents_to_admin_down.sql
-- ═══════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS restrict_caregiver_documents_to_admins ON public.caregiver_documents;

CREATE POLICY restrict_caregiver_documents_to_admins ON public.caregiver_documents
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Sanity: confirm the RESTRICTIVE policy landed. Exact-name match (not a
-- broad regex) so this check stays self-contained and does not couple to
-- other restrict_*_to_admins policies on unrelated tables.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*)
    INTO v_count
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname = 'caregiver_documents'
     AND p.polname = 'restrict_caregiver_documents_to_admins'
     AND p.polpermissive = false;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'expected restrict_caregiver_documents_to_admins RESTRICTIVE policy, found %',
      v_count;
  END IF;
END
$$;
