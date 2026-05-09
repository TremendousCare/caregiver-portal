-- ═══════════════════════════════════════════════════════════════
-- Restrict payroll & invoicing tables to admin role
--
-- Goal: members in the same org as an admin should NOT be able to
-- read (or write) timesheets, payroll runs, paychex logs, or invoices.
-- The existing tenant_isolation_* policies only check org_id, which
-- still grants access to every authenticated user in the tenant.
-- This migration ANDs a role check on top.
--
-- Approach: RESTRICTIVE policies. Postgres ANDs restrictive policies
-- with the existing permissive ones, so:
--   final = (org_id matches)            -- existing tenant_isolation_*
--         AND (caller is admin)         -- new restrict_*_to_admins
-- This is purely additive: no existing policy is modified or dropped,
-- and the new RESTRICTIVE policies can be removed in isolation by the
-- rollback to fully revert this PR.
--
-- Service role: unaffected. service_role bypasses RLS at the postgres
-- layer, and every table here has an explicit
-- service_role_full_access_<table> permissive policy as a defense-in-
-- depth marker. Cron jobs (payroll-generate-timesheets, invoicing
-- generators) and edge functions (paychex integration) all use the
-- service-role key and continue to function unchanged.
--
-- Role check: keyed on user_roles.role = 'admin', the same predicate
-- every other admin-gate in this codebase uses (automation_rules,
-- message_templates, action_item_rules, etc.). When Phase B5 of the
-- SaaS retrofit migrates the codebase to JWT org_role checks, these
-- policies migrate alongside the rest in one coordinated PR.
--
-- Tables in scope (7):
--   invoices, invoice_shifts, invoice_runs
--   timesheets, timesheet_shifts, payroll_runs, paychex_api_log
--
-- Production safety:
--   - Pure additive; no existing policy modified or dropped.
--   - Idempotent (DROP IF EXISTS + CREATE per policy).
--   - Sanity DO block aborts the deploy if the expected 7 policies
--     are not present after CREATE.
--   - No DDL on tables themselves.
--
-- Rollback: see _rollback/20260509000001_restrict_payroll_invoicing_to_admins_down.sql
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_tables text[] := ARRAY[
    'invoices',
    'invoice_shifts',
    'invoice_runs',
    'timesheets',
    'timesheet_shifts',
    'payroll_runs',
    'paychex_api_log'
  ];
  tbl text;
  v_count int;
BEGIN
  FOREACH tbl IN ARRAY v_tables LOOP
    -- Drop-then-create for idempotency. The deploy workflow uses
    -- supabase db push --include-all, which can re-apply this file.
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'restrict_' || tbl || '_to_admins', tbl
    );

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I
        AS RESTRICTIVE
        FOR ALL
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.email = lower((SELECT auth.jwt()) ->> 'email')
              AND ur.role = 'admin'
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.email = lower((SELECT auth.jwt()) ->> 'email')
              AND ur.role = 'admin'
          )
        )
    $f$, 'restrict_' || tbl || '_to_admins', tbl);
  END LOOP;

  -- Sanity: confirm all 7 RESTRICTIVE policies landed. The suffix-
  -- anchored regex matches B2b's lessons-locked filter style and
  -- avoids accidental collisions with future restrict_* policies on
  -- other tables.
  SELECT count(*)
    INTO v_count
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND p.polname ~ '^restrict_.*_to_admins$'
     AND p.polpermissive = false;

  IF v_count <> 7 THEN
    RAISE EXCEPTION
      'expected 7 restrict_*_to_admins RESTRICTIVE policies, found %',
      v_count;
  END IF;
END
$$;
