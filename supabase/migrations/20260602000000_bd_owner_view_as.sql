-- BD Module — owner "view-as" (read-only rep audit) support
--
-- Lets executive-tier users (role = 'owner', via public.is_owner()) read
-- another BD rep's personal-private data so the portal can mirror that
-- rep's exact view for auditing. This is SELECT-ONLY: owners can SEE a
-- rep's stars and mileage but can never INSERT/UPDATE/DELETE as the rep
-- — the write policies stay user_id = auth.uid(), so an owner acting in
-- a mirrored view can only ever write rows under their own id (and the
-- frontend renders the mirror read-only as a second line of defense).
--
-- Why this is safe under the RLS rules in CLAUDE.md / docs/RLS_GOTCHAS.md:
--   * public.is_owner() is the canonical STABLE SECURITY DEFINER helper
--     (migration 20260528000000). It reads user_roles — NOT the table the
--     policy is attached to — so it adds no self-referential layer to
--     bd_account_stars / bd_mileage_entries and cannot trip Postgres'
--     policy-recursion detector. SECURITY DEFINER is necessary but not
--     sufficient (CLAUDE.md); here the helper never re-enters the policy's
--     own table, so one level is all there is.
--   * Only the SELECT policies change. The INSERT/UPDATE/DELETE policies
--     on both tables are intentionally left as user_id = auth.uid().
--   * Audited per CLAUDE.md ("when adding a new SELECT policy on a table
--     that already has admin-gated UPDATE/INSERT/DELETE policies, audit
--     those existing policies in the same PR"): both tables carry only the
--     four tenant_isolation policies plus a service_role_full_access
--     policy. Neither write policy has an inline EXISTS subquery, so the
--     is_owner() branch added below is the only change to the policy chain
--     and there is no second-layer recursion risk.
--
-- Also adds two SECURITY DEFINER RPCs used by the frontend:
--   * bd_territory_cities_for_user(p_user_id) — the territory-cities
--     lookup, parameterized by target user. Returns the target's cities
--     only when the caller IS the target OR an owner; else [] (fail
--     closed). Generalizes bd_current_user_territory_cities().
--   * bd_list_auditable_reps() — the rep-picker source. Returns the
--     distinct BD reps (territory members) in the caller's org with email
--     + display name, ONLY when the caller is an owner; else no rows.
--     Excludes the caller themselves (auditing yourself is just your
--     normal view).
--
-- Production safety: pure additive / idempotent. DROP POLICY IF EXISTS
-- then CREATE for the two SELECT policies (re-runnable); CREATE OR REPLACE
-- FUNCTION for the RPCs. No table, column, or data changes.
-- Rollback: _rollback/20260602000000_bd_owner_view_as_down.sql

-- ─────────────────────────────────────────────────────────────────────
-- 1. bd_account_stars — owner read-override (SELECT only)
-- ─────────────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────────────
-- 2. bd_mileage_entries — owner read-override (SELECT only)
-- ─────────────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────────────
-- 3. Parameterized territory-cities lookup
-- ─────────────────────────────────────────────────────────────────────
--
-- Same shape as bd_current_user_territory_cities() but keyed by an
-- explicit target user. The frontend passes the "effective" user id
-- (self in the normal case, the audited rep when an owner is viewing-as).
-- Authorization lives in the WHERE clause: rows only match when the
-- caller is the target OR an owner, so an ordinary rep asking for someone
-- else's cities gets [] rather than an error.

CREATE OR REPLACE FUNCTION public.bd_territory_cities_for_user(p_user_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    array_agg(DISTINCT c.city),
    ARRAY[]::text[]
  )
  FROM bd_territory_members m
  JOIN bd_territories t ON t.id = m.territory_id
  CROSS JOIN LATERAL unnest(t.cities) AS c(city)
  WHERE m.user_id = p_user_id
    AND m.org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND (p_user_id = (SELECT auth.uid()) OR public.is_owner());
$$;

REVOKE ALL ON FUNCTION public.bd_territory_cities_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bd_territory_cities_for_user(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Auditable-reps list (owner-only)
-- ─────────────────────────────────────────────────────────────────────
--
-- Source for the owner's "View as" rep picker. Returns the distinct BD
-- reps (anyone with a territory membership) in the caller's org, with a
-- display name resolved from auth.users metadata (falling back to the
-- email local-part). Gated on public.is_owner() inside the WHERE so a
-- non-owner gets zero rows. Excludes the caller — an owner auditing
-- themselves is just their own view.

CREATE OR REPLACE FUNCTION public.bd_list_auditable_reps()
RETURNS TABLE (user_id uuid, email text, full_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT
    u.id AS user_id,
    u.email::text AS email,
    COALESCE(
      NULLIF(u.raw_user_meta_data ->> 'full_name', ''),
      split_part(u.email::text, '@', 1)
    ) AS full_name
  FROM bd_territory_members m
  JOIN auth.users u ON u.id = m.user_id
  WHERE m.org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND m.user_id <> (SELECT auth.uid())
    AND public.is_owner();
$$;

REVOKE ALL ON FUNCTION public.bd_list_auditable_reps() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bd_list_auditable_reps() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 5. Sanity checks — fail the deploy loudly if a piece is missing
-- ─────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'bd_territory_cities_for_user'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'bd_owner_view_as: public.bd_territory_cities_for_user(uuid) missing or not SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'bd_list_auditable_reps'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'bd_owner_view_as: public.bd_list_auditable_reps() missing or not SECURITY DEFINER';
  END IF;

  -- The owner-override SELECT policies must reference is_owner().
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'bd_account_stars'
      AND policyname = 'tenant_isolation_bd_account_stars_select'
      AND qual ILIKE '%is_owner()%'
  ) THEN
    RAISE EXCEPTION
      'bd_owner_view_as: bd_account_stars SELECT policy missing is_owner() branch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'bd_mileage_entries'
      AND policyname = 'tenant_isolation_bd_mileage_entries_select'
      AND qual ILIKE '%is_owner()%'
  ) THEN
    RAISE EXCEPTION
      'bd_owner_view_as: bd_mileage_entries SELECT policy missing is_owner() branch';
  END IF;
END $$;
