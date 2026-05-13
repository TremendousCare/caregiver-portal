-- BD Module — territories + strategic-shared flag
--
-- Adds the data model for rep territories so the BD portal can default
-- a rep's view to accounts inside their geographic scope, while still
-- surfacing accounts flagged as strategic (large health systems that
-- every rep coordinates with regardless of which sub-territory they
-- belong to).
--
-- New tables:
--   - bd_territories: a named region (e.g. "South OC") owned by an org
--     with a list of city strings. City-based matching is the only
--     practical option today because the Trello import only captured
--     name/type/city; lat/lng + address columns are sparse and getting
--     filled incrementally by the pin-on-visit flow (#325).
--   - bd_territory_members: many-to-many between users and territories
--     so a rep can be in more than one territory and a territory can be
--     covered by more than one rep.
--
-- New column:
--   - bd_accounts.is_strategic_shared: boolean, NOT NULL DEFAULT false.
--     When true the account is visible to every rep regardless of
--     territory membership. Used for large referral sources (Hoag,
--     Mission, UCI, Providence/St Joe's) that any rep may interact with.
--     Cell labeling is data-driven — the operator can flip this per
--     account from the admin UI later without a deploy.
--
-- Visibility model:
--   This migration is schema-only. It deliberately does NOT add
--   territory enforcement to the bd_accounts RLS policy. Reps still
--   need to be able to find any account in their org (manual entry,
--   referrals from out-of-territory sources, etc.). The frontend will
--   filter to "your accounts" by default (territory ∪ strategic) with
--   a "show all" toggle. RLS stays org-scoped only — same posture as
--   every other bd_* table.
--
-- Tenant isolation (per SaaS retrofit Phase B locked decisions):
--   - Every new table has org_id NOT NULL DEFAULT default_org_id()
--     REFERENCES organizations(id).
--   - Every new table carries four tenant_isolation policies plus a
--     service_role_full_access policy for cron + admin tasks.
--   - bd_territory_members carries its own org_id (denormalized from
--     bd_territories) so its RLS policy can stay a single-clause check
--     against the JWT and never has to subquery bd_territories. This
--     follows the RLS-gotcha rule (CLAUDE.md): inline EXISTS into the
--     parent table from a child policy is exactly the pattern that
--     trips Postgres' policy-recursion detector down the line. Keeping
--     org_id local makes both policies leaf-level.
--
-- Production safety:
--   Pure additive DDL. No DROP, no DELETE, no destructive UPDATE.
--   IF NOT EXISTS / DROP POLICY IF EXISTS / ADD COLUMN IF NOT EXISTS
--   throughout so `supabase db push --include-all` can replay safely.
--   Rollback: _rollback/20260513140000_bd_territories_and_strategic_flag_down.sql

-- ─────────────────────────────────────────────────────────────────
-- 1. bd_accounts.is_strategic_shared
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE bd_accounts
  ADD COLUMN IF NOT EXISTS is_strategic_shared boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN bd_accounts.is_strategic_shared IS
  'When true, this account is visible to every rep regardless of territory '
  'membership. Used for large health systems (Hoag, Mission, UCI, Providence) '
  'that any rep may interact with. Editable per account.';

-- ─────────────────────────────────────────────────────────────────
-- 2. bd_territories
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bd_territories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL DEFAULT public.default_org_id()
                REFERENCES organizations(id) ON DELETE RESTRICT,
  -- Human-readable label shown in the UI.
  name        text NOT NULL,
  -- List of city strings. Matched case-insensitively against bd_accounts.city
  -- at query time. Both formal and shorthand variants are stored side by
  -- side ("Rancho Mission Viejo" + "RMV") so historical data with abbreviated
  -- city values still matches without backfill.
  cities      text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bd_territories_org_name_unique
  ON bd_territories (org_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_bd_territories_org
  ON bd_territories (org_id);

ALTER TABLE bd_territories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_bd_territories_select" ON bd_territories;
CREATE POLICY "tenant_isolation_bd_territories_select"
  ON bd_territories FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_territories_insert" ON bd_territories;
CREATE POLICY "tenant_isolation_bd_territories_insert"
  ON bd_territories FOR INSERT
  TO authenticated
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_territories_update" ON bd_territories;
CREATE POLICY "tenant_isolation_bd_territories_update"
  ON bd_territories FOR UPDATE
  TO authenticated
  USING      (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid)
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_territories_delete" ON bd_territories;
CREATE POLICY "tenant_isolation_bd_territories_delete"
  ON bd_territories FOR DELETE
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "service_role_full_access_bd_territories" ON bd_territories;
CREATE POLICY "service_role_full_access_bd_territories"
  ON bd_territories FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS bd_territories_set_updated_at ON bd_territories;
CREATE TRIGGER bd_territories_set_updated_at
  BEFORE UPDATE ON bd_territories
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- 3. bd_territory_members
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bd_territory_members (
  territory_id uuid NOT NULL REFERENCES bd_territories(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id)     ON DELETE CASCADE,
  -- Denormalized for RLS — see header comment for rationale.
  org_id       uuid NOT NULL DEFAULT public.default_org_id()
                 REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (territory_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_bd_territory_members_org
  ON bd_territory_members (org_id);

CREATE INDEX IF NOT EXISTS idx_bd_territory_members_user
  ON bd_territory_members (user_id);

ALTER TABLE bd_territory_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_bd_territory_members_select" ON bd_territory_members;
CREATE POLICY "tenant_isolation_bd_territory_members_select"
  ON bd_territory_members FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_territory_members_insert" ON bd_territory_members;
CREATE POLICY "tenant_isolation_bd_territory_members_insert"
  ON bd_territory_members FOR INSERT
  TO authenticated
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_territory_members_update" ON bd_territory_members;
CREATE POLICY "tenant_isolation_bd_territory_members_update"
  ON bd_territory_members FOR UPDATE
  TO authenticated
  USING      (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid)
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "tenant_isolation_bd_territory_members_delete" ON bd_territory_members;
CREATE POLICY "tenant_isolation_bd_territory_members_delete"
  ON bd_territory_members FOR DELETE
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

DROP POLICY IF EXISTS "service_role_full_access_bd_territory_members" ON bd_territory_members;
CREATE POLICY "service_role_full_access_bd_territory_members"
  ON bd_territory_members FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────
-- 4. Lookup helper: cities visible to the current user
-- ─────────────────────────────────────────────────────────────────
--
-- Returns the union of every city string across every territory the
-- caller is a member of in their current org. Used by the frontend
-- via .rpc('bd_current_user_territory_cities') so the same matching
-- rule lives in one place. STABLE so it's safe to call inside other
-- queries and views.

CREATE OR REPLACE FUNCTION public.bd_current_user_territory_cities()
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
  WHERE m.user_id = auth.uid()
    AND m.org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid;
$$;

GRANT EXECUTE ON FUNCTION public.bd_current_user_territory_cities() TO authenticated;
