-- Voice / CTI Phase 1 PR 3.4 — admin UPDATE policy on org_memberships.
--
-- The Voice & Calls admin panel (PR #319) lets admins bind staff
-- to RingCentral extension IDs by writing
-- org_memberships.ringcentral_extension_id from the browser. PR A
-- (20260422000001_create_org_memberships.sql) shipped only a SELECT
-- policy (`users_read_own_memberships`), so authenticated UPDATEs
-- are silently denied by RLS — Supabase reports zero-rows-affected
-- as success, the UI toasts "Extension bound" but the value never
-- persists.
--
-- This migration adds an admin-gated, org-scoped UPDATE policy.
-- Predicate gates on public.is_admin() (the canonical
-- SECURITY DEFINER helper per docs/RLS_GOTCHAS.md) and on
-- org_id matching the caller's JWT org claim. Non-admins continue
-- to be unable to UPDATE org_memberships.
--
-- Audit notes:
--   - Admin can mutate ANY column on org_memberships rows in their
--     own org — including role and user_id. That's the same
--     blast radius admins already have through Settings → User
--     Management on the user_roles table, so we're not expanding
--     it. If/when we tighten admin write to specific columns, do
--     it via an `INSTEAD OF UPDATE` trigger and not via narrower
--     RLS (Postgres RLS is row-level, not column-level).
--   - INSERT / DELETE on org_memberships remain service-role only
--     (handled by the AFTER INSERT trigger on auth.users from
--     Phase B2a). The Voice & Calls UI never inserts memberships.
--
-- Rollback: see _rollback/20260513020000_*.

CREATE POLICY "admins_update_org_memberships"
  ON public.org_memberships
  FOR UPDATE
  TO authenticated
  USING (
    public.is_admin()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  )
  WITH CHECK (
    public.is_admin()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

-- Sanity check.
DO $$
DECLARE
  v_using_expr text;
  v_check_expr text;
BEGIN
  SELECT pg_get_expr(p.polqual, p.polrelid),
         pg_get_expr(p.polwithcheck, p.polrelid)
    INTO v_using_expr, v_check_expr
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'org_memberships'
     AND p.polname = 'admins_update_org_memberships';

  IF v_using_expr IS NULL THEN
    RAISE EXCEPTION 'admins_update_org_memberships policy missing after migration';
  END IF;

  IF v_using_expr NOT LIKE '%is_admin()%' THEN
    RAISE EXCEPTION
      'admins_update_org_memberships USING does not reference is_admin(); got: %',
      v_using_expr;
  END IF;

  IF v_check_expr NOT LIKE '%is_admin()%' THEN
    RAISE EXCEPTION
      'admins_update_org_memberships WITH CHECK does not reference is_admin(); got: %',
      v_check_expr;
  END IF;
END
$$;
