-- ═══════════════════════════════════════════════════════════════
-- user_roles: restore admin visibility into the full users list
--
-- Background: migration 20260418210000_caregiver_portal_rls.sql replaced
-- the broad `authenticated_read_user_roles USING (true)` SELECT policy
-- with `user_roles_read_own` (email = auth.jwt() email) to stop
-- caregivers from enumerating staff. That fix is correct, but it also
-- hid every other staff row from admins, breaking the User Access &
-- Roles section of Admin Settings (only the current user's row was
-- returned).
--
-- This migration adds a second permissive SELECT policy scoped to admins
-- only. Because permissive policies OR together:
--   - members / caregivers → still see only their own row (read_own)
--   - admins              → see every row (read_all)
--
-- The Admin Settings page is already gated to admin-only at the route
-- level (AdminApp.jsx → if (!isAdmin) <NoAccess/>), so the database
-- policy and the UI route line up: only admins reach the page, and only
-- admins get the full list back from the query.
--
-- Production safety: pure additive. No existing policy is modified or
-- dropped. The existing user_roles_read_own policy continues to grant
-- self-reads for every authenticated user.
--
-- Rollback: see _rollback/20260509000000_user_roles_admins_read_all_down.sql
-- ═══════════════════════════════════════════════════════════════

-- Idempotent: drop the policy first so this migration can be re-run
-- safely (deploy workflow uses `supabase db push --include-all`).
DROP POLICY IF EXISTS user_roles_admins_read_all ON public.user_roles;

CREATE POLICY user_roles_admins_read_all ON public.user_roles
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.email = lower((SELECT auth.jwt()) ->> 'email')
        AND ur.role = 'admin'
    )
  );

-- Sanity check: abort the deploy if the policy did not land.
DO $$
BEGIN
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
