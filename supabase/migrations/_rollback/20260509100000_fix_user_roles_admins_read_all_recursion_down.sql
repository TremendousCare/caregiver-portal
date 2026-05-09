-- Rollback for 20260509100000_fix_user_roles_admins_read_all_recursion.sql
--
-- Drops the fixed policy and the is_admin() function. Returns
-- user_roles SELECT-RLS to { user_roles_read_own } only — the
-- pre-PR-1 state. Admins will once again see only their own row in
-- the User Access & Roles list, but the role lookup itself works
-- (no recursion).
--
-- We deliberately do NOT recreate the recursive form of
-- user_roles_admins_read_all. That form is a known production
-- incident and must never run again.
--
-- Order matters: drop the policy first (it depends on the function),
-- then drop the function.

DROP POLICY IF EXISTS user_roles_admins_read_all ON public.user_roles;
DROP FUNCTION IF EXISTS public.is_admin();
