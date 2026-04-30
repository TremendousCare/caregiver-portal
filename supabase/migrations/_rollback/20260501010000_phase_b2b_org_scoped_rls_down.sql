-- Rollback for Phase B2b — drop every tenant_isolation_* RLS policy.
-- This file lives outside the main migrations folder (underscored directory),
-- so it is NOT auto-applied. Run manually via psql only if Phase B2b must be
-- reverted.
--
-- Because B2b is purely additive (the new policies OR with the existing
-- permissive ones), dropping them returns the system to exactly the
-- pre-B2b state. No data is altered.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260501010000_phase_b2b_org_scoped_rls_down.sql

-- The filter below is suffix-anchored to '_(select|insert|update|delete)$' so
-- it targets ONLY B2b's own policies. The Paychex payroll work shipped four
-- pre-existing tenant_isolation_* policies (tenant_isolation_payroll_runs,
-- tenant_isolation_timesheets, tenant_isolation_timesheet_shifts,
-- tenant_isolation_payroll_exports_read on storage.objects) — none of which
-- carry a per-command suffix, so the regex correctly excludes them. A
-- broader LIKE 'tenant_isolation\_%' filter would have wrongly dropped
-- those Paychex policies.

BEGIN;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, p.polname
    FROM pg_policy p
    JOIN pg_class c     ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE p.polname ~ '^tenant_isolation_.*_(select|insert|update|delete)$'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   r.polname, r.schema_name, r.table_name);
  END LOOP;
END $$;

COMMIT;
