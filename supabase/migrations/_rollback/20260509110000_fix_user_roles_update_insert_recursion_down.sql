-- Rollback for 20260509110000_fix_user_roles_update_insert_recursion.sql
--
-- Drops the fixed UPDATE and INSERT policies on user_roles. Does NOT
-- recreate the buggy inline-EXISTS form. After rollback, admins can
-- still SELECT user_roles via the existing read policies, but role
-- toggling and new-user inserts will be blocked entirely until a
-- replacement migration ships.
--
-- This is the safer rest position. Restoring the inline-EXISTS form
-- would re-introduce the recursion incident as long as
-- user_roles_admins_read_all (from 20260509100000) exists. To fully
-- revert role-management RLS, run this rollback AND
-- 20260509100000_fix_user_roles_admins_read_all_recursion_down.sql
-- in reverse order; that returns user_roles to the pre-PR-1 state
-- where only user_roles_read_own grants SELECT.

DROP POLICY IF EXISTS admins_update_user_roles ON public.user_roles;
DROP POLICY IF EXISTS user_roles_admins_insert ON public.user_roles;
