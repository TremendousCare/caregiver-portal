-- Rollback for 20260528203410_payroll_rls_use_is_admin_helper.sql
--
-- Restores the original PR #288 predicate: the 7 payroll/invoicing
-- RESTRICTIVE policies revert to the inline literal `role = 'admin'`
-- check (re-excluding the 'owner' tier).
--
-- WARNING: running this rollback re-introduces the incident — owners
-- lose access to payroll & invoicing again. Only roll back if the
-- is_admin()-based policy is shown to cause a regression.

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
END
$$;
