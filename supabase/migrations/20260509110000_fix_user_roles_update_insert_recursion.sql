-- ═══════════════════════════════════════════════════════════════
-- Hotfix: admins_update_user_roles + user_roles_admins_insert
--          recursion (sibling to 20260509100000)
--
-- The previous hotfix (20260509100000) patched user_roles_admins_read_all
-- but left the two other admin-gated policies on user_roles untouched:
--
--   admins_update_user_roles   (UPDATE) — inline EXISTS (SELECT … FROM user_roles)
--   user_roles_admins_insert   (INSERT) — inline EXISTS (SELECT … FROM user_roles)
--
-- Both shipped 2026-02-14 in 20260214201225_harden_rls_policies.sql
-- and worked fine for ~3 months because there was only one SELECT
-- policy on user_roles back then (user_roles_read_own — a trivial
-- email-equality check). When that policy fired during the inline
-- subquery, no recursion was possible.
--
-- 2026-05-09 added user_roles_admins_read_all (a second SELECT
-- policy). Even though the followup hotfix made it use the
-- SECURITY DEFINER public.is_admin() function, Postgres' policy
-- recursion detector tracks the chain at the table-reference level
-- inside a single statement. UPDATE/INSERT on user_roles now
-- chains:
--
--   UPDATE user_roles
--   └─ admins_update_user_roles USING evaluates inline EXISTS
--      └─ inner SELECT on user_roles triggers SELECT-RLS
--         └─ user_roles_admins_read_all → is_admin()
--            └─ DETECTED: re-entrance into user_roles policy stack
--
-- (SELECT on user_roles works fine — that chain is only one level
-- deep into user_roles and SECURITY DEFINER cleanly bypasses RLS.
-- Two levels — UPDATE→SELECT — is what trips the detector.)
--
-- Fix: rewrite both admin-gated UPDATE/INSERT policies to call
-- public.is_admin() directly. Eliminating the inline EXISTS removes
-- the inner SELECT against user_roles, breaking the chain at the
-- top of the second level. is_admin() bypasses RLS for its internal
-- lookup; the policy itself does not re-enter user_roles RLS.
--
-- Behavior is identical: an admin can update / insert any row, a
-- non-admin cannot. The only change is the implementation path.
--
-- Production safety:
--   - Pure additive function reuse (public.is_admin() already exists).
--   - Idempotent: DROP IF EXISTS + CREATE per policy.
--   - No table schema change.
--   - Sanity DO block aborts the deploy if either policy is missing
--     or still references the buggy inline-EXISTS predicate.
--
-- Rollback: see _rollback/...down.sql. Drops the new policies and
-- does NOT recreate the buggy inline form. To fully revert
-- role-management policies, run rollbacks for this migration AND
-- 20260509100000 in reverse order; that returns user_roles to the
-- pre-PR-1 state.
-- ═══════════════════════════════════════════════════════════════

-- 1. UPDATE policy. The previous form had an inline EXISTS subquery
--    against user_roles itself; the new form delegates to
--    public.is_admin() which is SECURITY DEFINER and bypasses RLS.
DROP POLICY IF EXISTS admins_update_user_roles ON public.user_roles;

CREATE POLICY admins_update_user_roles ON public.user_roles
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 2. INSERT policy. Same shape as UPDATE — delegate to is_admin().
DROP POLICY IF EXISTS user_roles_admins_insert ON public.user_roles;

CREATE POLICY user_roles_admins_insert ON public.user_roles
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

-- 3. Sanity check.
DO $$
DECLARE
  v_update_using_expr text;
  v_insert_check_expr text;
BEGIN
  SELECT pg_get_expr(p.polqual, p.polrelid)
    INTO v_update_using_expr
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'user_roles'
     AND p.polname = 'admins_update_user_roles';

  IF v_update_using_expr IS NULL THEN
    RAISE EXCEPTION
      'admins_update_user_roles policy missing after migration';
  END IF;

  IF v_update_using_expr NOT LIKE '%is_admin()%' THEN
    RAISE EXCEPTION
      'admins_update_user_roles USING does not reference is_admin(); got: %',
      v_update_using_expr;
  END IF;

  SELECT pg_get_expr(p.polwithcheck, p.polrelid)
    INTO v_insert_check_expr
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'user_roles'
     AND p.polname = 'user_roles_admins_insert';

  IF v_insert_check_expr IS NULL THEN
    RAISE EXCEPTION
      'user_roles_admins_insert policy missing after migration';
  END IF;

  IF v_insert_check_expr NOT LIKE '%is_admin()%' THEN
    RAISE EXCEPTION
      'user_roles_admins_insert WITH CHECK does not reference is_admin(); got: %',
      v_insert_check_expr;
  END IF;
END
$$;
