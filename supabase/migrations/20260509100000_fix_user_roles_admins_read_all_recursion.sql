-- ═══════════════════════════════════════════════════════════════
-- Hotfix: user_roles_admins_read_all RLS recursion
--
-- Bug: migration 20260509000000_user_roles_admins_read_all.sql
-- created a SELECT policy on user_roles whose USING predicate did
-- an inline EXISTS (SELECT 1 FROM user_roles ...). Because that
-- inner SELECT against user_roles itself triggers SELECT-RLS on
-- user_roles, the same policy is re-evaluated → infinite recursion.
--
-- Postgres detects this and aborts every user_roles SELECT with:
--   ERROR: infinite recursion detected in policy for relation "user_roles"
--
-- Cascade impact on production:
--   - Frontend AppContext role lookup 500s → isAdmin = false for
--     every caller → Settings / Accounting / BD admin pages hidden
--     for everyone, including real admins.
--   - PR 3's RESTRICTIVE policies (restrict_*_to_admins) on
--     payroll/invoicing tables also do an EXISTS subquery against
--     user_roles; that inner SELECT triggers the same recursion →
--     payroll & invoicing queries fail too.
--
-- Why the existing admins_update_user_roles policy (same EXISTS
-- pattern, in production since Feb 2026) didn't expose this: it's
-- an UPDATE policy, so SELECT statements never trigger it. SELECT
-- was the unsafe surface.
--
-- Fix: extract the admin check into a STABLE SECURITY DEFINER
-- function so the inner SELECT runs as the function owner
-- (postgres) and bypasses RLS — same pattern as public.is_staff()
-- already in this codebase. The function takes its email from
-- auth.jwt() which is connection-scoped, so it still reflects the
-- caller's identity even though the function runs as postgres.
--
-- This also fixes PR 3's restrictive policies as a side effect:
-- their inner SELECT on user_roles still goes through user_roles
-- SELECT-RLS, but user_roles_admins_read_all is now non-recursive,
-- so no error. PR 3 policies could later be refactored to call
-- public.is_admin() directly for cleaner plans, but that's a
-- separate PR; this hotfix is intentionally minimal.
--
-- Production safety:
--   - Pure additive function; idempotent CREATE OR REPLACE.
--   - Policy DROP IF EXISTS + CREATE (re-runnable).
--   - No table schema change.
--   - Sanity DO block aborts the deploy if the function or policy
--     is missing post-create.
--
-- Rollback: see _rollback/20260509100000_fix_user_roles_admins_read_all_recursion_down.sql
-- The rollback drops the new policy and the new function. It does
-- NOT recreate the buggy form — leaving user_roles SELECT-RLS at
-- just user_roles_read_own (pre-PR-1 state) is far safer than
-- re-introducing a known recursion bug.
-- ═══════════════════════════════════════════════════════════════

-- 1. Drop the recursive policy.
DROP POLICY IF EXISTS user_roles_admins_read_all ON public.user_roles;

-- 2. Create the admin-check helper. SECURITY DEFINER means the
--    inner SELECT runs as the function owner (postgres), bypassing
--    RLS on user_roles for that lookup only. The check is keyed on
--    the *caller's* JWT email, so the result is correct for the
--    authenticated user even though the SELECT itself is privileged.
--    Mirrors the structure of public.is_staff() exactly.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE email = lower((auth.jwt() ->> 'email'))
      AND role = 'admin'
  );
$$;

-- 3. Recreate the policy using the function. The predicate is now
--    a single function call — no recursive SELECT through RLS.
CREATE POLICY user_roles_admins_read_all ON public.user_roles
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- 4. Sanity check: confirm the function and policy both landed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'is_admin'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'public.is_admin() function missing or not SECURITY DEFINER after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'user_roles'
      AND p.polname = 'user_roles_admins_read_all'
  ) THEN
    RAISE EXCEPTION
      'user_roles_admins_read_all policy missing after migration';
  END IF;
END
$$;
