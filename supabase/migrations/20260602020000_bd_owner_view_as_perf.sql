-- BD owner view-as — RLS performance hardening.
--
-- Follow-up to 20260602000000. The owner read-override added
-- `OR public.is_owner()` to the SELECT policies on bd_account_stars and
-- bd_mileage_entries. Bare `is_owner()` in a USING clause can be
-- re-evaluated per row, and each call runs a subquery into user_roles —
-- the same anti-pattern Supabase's RLS performance guide warns about for
-- bare auth.uid()/auth.jwt() calls. The original org_id/user_id checks
-- were already wrapped as `(SELECT auth.jwt())` / `(SELECT auth.uid())`
-- so Postgres hoists them into a once-per-query InitPlan; this migration
-- gives is_owner() the same treatment by wrapping it as
-- `(SELECT public.is_owner())`.
--
-- Functionally identical to 20260602000000 — same true/false result,
-- same SELECT-only override, write policies untouched. Pure performance
-- + correctness-of-form change.
--
-- Production safety: DROP POLICY IF EXISTS + CREATE, re-runnable, no
-- table/column/data changes.
-- Rollback: _rollback/20260602020000_bd_owner_view_as_perf_down.sql
--   (reverts to the bare is_owner() form from 20260602000000).

DROP POLICY IF EXISTS "tenant_isolation_bd_account_stars_select" ON bd_account_stars;
CREATE POLICY "tenant_isolation_bd_account_stars_select"
  ON bd_account_stars FOR SELECT
  TO authenticated
  USING (
    org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND (
      user_id = (SELECT auth.uid())
      OR (SELECT public.is_owner())
    )
  );

DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_select" ON bd_mileage_entries;
CREATE POLICY "tenant_isolation_bd_mileage_entries_select"
  ON bd_mileage_entries FOR SELECT
  TO authenticated
  USING (
    org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND (
      user_id = (SELECT auth.uid())
      OR (SELECT public.is_owner())
    )
  );
