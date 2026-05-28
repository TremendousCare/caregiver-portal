-- ═══════════════════════════════════════════════════════════════
-- Fix: payroll & invoicing RESTRICTIVE policies must allow `owner`
--
-- Incident: owners (Kevin, Blerta, kevinnash@tremendouscareca.com)
-- could not see ANY rows on the 7 payroll/invoicing tables. The
-- "This Week" payroll view rendered "No timesheets ... yet" even
-- though draft timesheets existed in the table.
--
-- Root cause: migration 20260509000001 created RESTRICTIVE policies
-- that inline a literal role check:
--
--     EXISTS (SELECT 1 FROM user_roles ur
--             WHERE ur.email = lower(auth.jwt() ->> 'email')
--               AND ur.role = 'admin')        -- ← excludes 'owner'
--
-- Postgres ANDs RESTRICTIVE policies with the permissive
-- tenant_isolation_* policies, so an owner whose org_id matches is
-- STILL denied because the literal `role = 'admin'` is false for the
-- 'owner' tier. This is exactly the literal-role-check failure mode
-- CLAUDE.md documents ("Kevin + Blerta lost admin access"): owners
-- are hierarchically admins, but a literal `= 'admin'` silently
-- revokes their access.
--
-- Fix: replace the inline literal with the canonical
-- `public.is_admin()` SECURITY DEFINER helper, which checks
-- `role IN ('admin', 'owner')` and is the single source of truth that
-- the frontend `isAdminRole()` helper mirrors. No more literal role
-- comparisons in these policies.
--
-- Why is_admin() is safe inside an RLS policy here:
--   - is_admin() is STABLE SECURITY DEFINER and selects from
--     `user_roles`, NOT from the table the policy guards. There is no
--     same-table recursion (the RLS_GOTCHAS recursion trap requires
--     the inner SELECT to hit the policy's own table).
--   - The same helper already backs admin-gated policies elsewhere in
--     the schema.
--
-- Tables in scope (7) — unchanged from 20260509000001:
--   invoices, invoice_shifts, invoice_runs,
--   timesheets, timesheet_shifts, payroll_runs, paychex_api_log
--
-- Production safety:
--   - Additive / corrective only. Drops and recreates the SAME named
--     RESTRICTIVE policies; no table DDL, no data touched.
--   - Idempotent (DROP IF EXISTS + CREATE), safe under
--     `supabase db push --include-all`.
--   - service_role continues to bypass RLS; cron + edge functions
--     unaffected.
--   - Net effect is a STRICT WIDENING of access from {admin} to
--     {admin, owner} — it grants the access owners were always meant
--     to have; it does not expose payroll to members (the permissive
--     tenant_isolation_* policy is still ANDed, and members are
--     neither admin nor owner).
--   - Sanity DO block aborts the deploy unless all 7 policies are
--     present and reference is_admin().
--
-- Rollback: _rollback/20260528203410_payroll_rls_use_is_admin_helper_down.sql
--   (restores the literal `role = 'admin'` predicate from PR #288).
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
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'restrict_' || tbl || '_to_admins', tbl
    );

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I
        AS RESTRICTIVE
        FOR ALL
        TO authenticated
        USING (public.is_admin())
        WITH CHECK (public.is_admin())
    $f$, 'restrict_' || tbl || '_to_admins', tbl);
  END LOOP;

  -- Sanity: confirm all 7 RESTRICTIVE policies landed AND now route
  -- through is_admin() (no lingering literal 'admin' predicate).
  SELECT count(*)
    INTO v_count
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND p.polname ~ '^restrict_.*_to_admins$'
     AND p.polpermissive = false
     AND pg_get_expr(p.polqual, p.polrelid) ILIKE '%is_admin()%';

  IF v_count <> 7 THEN
    RAISE EXCEPTION
      'expected 7 restrict_*_to_admins RESTRICTIVE policies routing through is_admin(), found %',
      v_count;
  END IF;
END
$$;
