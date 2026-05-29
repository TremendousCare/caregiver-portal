-- Rollback for 20260602010000_bd_owner_view_as_perf.
--
-- Reverts the two SELECT policies to the bare is_owner() form from
-- 20260602000000. Functionally identical; only the (SELECT ...) wrapper
-- that hoists is_owner() into a once-per-query InitPlan is removed.

DROP POLICY IF EXISTS "tenant_isolation_bd_account_stars_select" ON bd_account_stars;
CREATE POLICY "tenant_isolation_bd_account_stars_select"
  ON bd_account_stars FOR SELECT
  TO authenticated
  USING (
    org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND (
      user_id = (SELECT auth.uid())
      OR public.is_owner()
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
      OR public.is_owner()
    )
  );
