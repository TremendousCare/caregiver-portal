
-- ============================================================
-- Security Hardening: RLS Policy Fixes
-- ============================================================
-- 1. Replace wide-open policies on caregivers and app_data
-- 2. Wrap auth.jwt()/auth.role() in subqueries (InitPlan optimization)
-- 3. Fix caregiver_documents to use proper role scoping
-- 4. Tighten user_roles INSERT policies to authenticated role only
-- ============================================================

-- ═══════════════════════════════════════════════════════════════
-- CAREGIVERS: Replace "Allow all access" (USING true) with
-- authenticated-only policy
-- ═══════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Allow all access" ON public.caregivers;

CREATE POLICY "authenticated_full_access_caregivers"
  ON public.caregivers
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Service role needs access for Edge Functions (automation-cron, etc.)
CREATE POLICY "service_role_full_access_caregivers"
  ON public.caregivers
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- APP_DATA: Replace "Allow all access" (USING true) with
-- authenticated-only policy
-- ═══════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Allow all access" ON public.app_data;

CREATE POLICY "authenticated_full_access_app_data"
  ON public.app_data
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Service role needs access for Edge Functions
CREATE POLICY "service_role_full_access_app_data"
  ON public.app_data
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- CAREGIVER_DOCUMENTS: Fix to use role-based grant instead of
-- auth.role() check (performance + correctness)
-- ═══════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Authenticated full access" ON public.caregiver_documents;

CREATE POLICY "authenticated_full_access_caregiver_documents"
  ON public.caregiver_documents
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Service role for Edge Functions (sharepoint-docs)
CREATE POLICY "service_role_full_access_caregiver_documents"
  ON public.caregiver_documents
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════
-- APP_SETTINGS: Wrap auth.jwt() in subqueries (InitPlan optimization)
-- ═══════════════════════════════════════════════════════════════
-- Drop existing policies
DROP POLICY IF EXISTS "Authenticated users can read app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "admins_insert_app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "admins_update_app_settings" ON public.app_settings;
-- Keep service_role policy as-is (no auth.jwt() call)

-- Recreate with optimized auth checks
CREATE POLICY "authenticated_read_app_settings"
  ON public.app_settings
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "admins_insert_app_settings"
  ON public.app_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.email = lower((select auth.jwt()) ->> 'email')
        AND user_roles.role = 'admin'
    )
  );

CREATE POLICY "admins_update_app_settings"
  ON public.app_settings
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.email = lower((select auth.jwt()) ->> 'email')
        AND user_roles.role = 'admin'
    )
  );

-- ═══════════════════════════════════════════════════════════════
-- AUTOMATION_RULES: Wrap auth.jwt() in subqueries + tighten roles
-- ═══════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "allow_authenticated_read_automation_rules" ON public.automation_rules;
DROP POLICY IF EXISTS "allow_admin_insert_automation_rules" ON public.automation_rules;
DROP POLICY IF EXISTS "allow_admin_update_automation_rules" ON public.automation_rules;
DROP POLICY IF EXISTS "allow_admin_delete_automation_rules" ON public.automation_rules;

CREATE POLICY "authenticated_read_automation_rules"
  ON public.automation_rules
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "admin_insert_automation_rules"
  ON public.automation_rules
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.email = lower((select auth.jwt()) ->> 'email')
        AND user_roles.role = 'admin'
    )
  );

CREATE POLICY "admin_update_automation_rules"
  ON public.automation_rules
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.email = lower((select auth.jwt()) ->> 'email')
        AND user_roles.role = 'admin'
    )
  );

CREATE POLICY "admin_delete_automation_rules"
  ON public.automation_rules
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.email = lower((select auth.jwt()) ->> 'email')
        AND user_roles.role = 'admin'
    )
  );

-- Service role for automation-cron Edge Function reads
CREATE POLICY "service_role_read_automation_rules"
  ON public.automation_rules
  FOR SELECT
  TO service_role
  USING (true);

-- ═══════════════════════════════════════════════════════════════
-- USER_ROLES: Wrap auth.jwt() in subqueries + tighten to
-- authenticated role only (was public)
-- ═══════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "authenticated_read_user_roles" ON public.user_roles;
DROP POLICY IF EXISTS "admins_insert_user_roles" ON public.user_roles;
DROP POLICY IF EXISTS "admins_update_user_roles" ON public.user_roles;
DROP POLICY IF EXISTS "self_register_as_member" ON public.user_roles;

CREATE POLICY "authenticated_read_user_roles"
  ON public.user_roles
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "admins_manage_user_roles"
  ON public.user_roles
  FOR INSERT
  TO authenticated
  WITH CHECK (
    -- Admin can insert any role
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.email = lower((select auth.jwt()) ->> 'email')
        AND ur.role = 'admin'
    )
    OR
    -- Self-registration: user can insert their own email as 'member' only
    (
      email = lower((select auth.jwt()) ->> 'email')
      AND role = 'member'
    )
  );

CREATE POLICY "admins_update_user_roles"
  ON public.user_roles
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.email = lower((select auth.jwt()) ->> 'email')
        AND ur.role = 'admin'
    )
  );

-- ═══════════════════════════════════════════════════════════════
-- AUTOMATION_LOG: Already correct, but wrap auth.role() for consistency
-- ═══════════════════════════════════════════════════════════════
-- These are already using TO authenticated/service_role grants,
-- no auth.jwt() calls, so no changes needed.
