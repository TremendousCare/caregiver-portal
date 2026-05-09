-- Rollback for 20260509000000_user_roles_admins_read_all.sql
--
-- Drops the admin-wide SELECT policy on user_roles. After running this,
-- admins will once again only see their own row in Admin Settings →
-- User Access & Roles. The existing user_roles_read_own policy is
-- untouched so members keep their self-read access.

DROP POLICY IF EXISTS user_roles_admins_read_all ON public.user_roles;
