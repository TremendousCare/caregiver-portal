-- Rollback for 20260509000001_restrict_payroll_invoicing_to_admins.sql
--
-- Drops the seven RESTRICTIVE policies that gate payroll & invoicing
-- tables to admin-role callers. After running this, members in the
-- org regain SELECT/INSERT/UPDATE/DELETE access to these tables (the
-- existing tenant_isolation_* permissive policies are untouched and
-- continue to grant org-scoped access to every authenticated user).
--
-- Suffix-anchored DROP target list (matches the migration's regex
-- exactly) so we cannot accidentally drop unrelated restrict_* policies
-- that may exist elsewhere in the schema today or in the future.

DROP POLICY IF EXISTS restrict_invoices_to_admins        ON public.invoices;
DROP POLICY IF EXISTS restrict_invoice_shifts_to_admins  ON public.invoice_shifts;
DROP POLICY IF EXISTS restrict_invoice_runs_to_admins    ON public.invoice_runs;
DROP POLICY IF EXISTS restrict_timesheets_to_admins      ON public.timesheets;
DROP POLICY IF EXISTS restrict_timesheet_shifts_to_admins ON public.timesheet_shifts;
DROP POLICY IF EXISTS restrict_payroll_runs_to_admins    ON public.payroll_runs;
DROP POLICY IF EXISTS restrict_paychex_api_log_to_admins ON public.paychex_api_log;
