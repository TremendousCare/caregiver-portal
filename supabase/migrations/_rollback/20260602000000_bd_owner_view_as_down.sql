-- Rollback for bd_owner_view_as.
--
-- Restores the original personal-private SELECT policies on
-- bd_account_stars and bd_mileage_entries (user_id = auth.uid() only,
-- no owner read-override) and drops the two view-as RPCs.
--
-- Safe to run anytime: the frontend treats the RPCs and the owner
-- override as additive (a missing bd_list_auditable_reps simply means
-- the rep picker shows nothing and the portal behaves exactly as it did
-- before this feature). No data is touched.

-- 1. bd_account_stars — restore self-only SELECT
DROP POLICY IF EXISTS "tenant_isolation_bd_account_stars_select" ON bd_account_stars;
CREATE POLICY "tenant_isolation_bd_account_stars_select"
  ON bd_account_stars FOR SELECT
  TO authenticated
  USING (
    org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND user_id = (SELECT auth.uid())
  );

-- 2. bd_mileage_entries — restore self-only SELECT
DROP POLICY IF EXISTS "tenant_isolation_bd_mileage_entries_select" ON bd_mileage_entries;
CREATE POLICY "tenant_isolation_bd_mileage_entries_select"
  ON bd_mileage_entries FOR SELECT
  TO authenticated
  USING (
    org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND user_id = (SELECT auth.uid())
  );

-- 3. Drop the view-as RPCs
DROP FUNCTION IF EXISTS public.bd_territory_cities_for_user(uuid);
DROP FUNCTION IF EXISTS public.bd_list_auditable_reps();
