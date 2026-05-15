-- BD Module — bd_account_stars (per-rep account favorites)
--
-- Adds personal "starred" flags between BD users and accounts so a rep
-- can carve a working shortlist out of their territory. Stars are
-- private to the user — invisible to other reps and to admins reading
-- as another rep — and orthogonal to the org-wide constructs we already
-- have (territory membership, is_strategic_shared, source).
--
-- Why a separate table (vs a `starred_by_user_ids uuid[]` column on
-- bd_accounts):
--   * Per-user privacy via RLS — the SELECT policy is a single-clause
--     leaf check (`user_id = auth.uid() AND org_id = jwt.org_id`), so
--     even an admin acting on behalf of a different rep can't see Amy's
--     stars. With an array column we'd have to filter array contents
--     in every query and couldn't enforce read-privacy in RLS.
--   * Future evolution path. Today stars are personal; tomorrow we may
--     want formal account assignment (Amy is the owner of these 30
--     accounts; the team can see it). Adding a `role` column to this
--     table later (e.g. 'star' | 'owner' | 'coverage') is additive and
--     non-breaking.
--   * Symmetric with bd_territory_members — the same pattern (PK on
--     (entity, user) plus denormalized org_id for leaf-level RLS).
--
-- RLS posture:
--   Personal-private. SELECT/INSERT/DELETE all require
--   `user_id = auth.uid()`. Admin override is intentionally omitted —
--   admins can read raw rows via service_role if needed for support,
--   but the application never reads another user's stars. UPDATE has
--   no policy because rows are immutable (created_at is the only
--   non-key column); a star is created or deleted, never edited.
--
-- Production safety: pure additive. CREATE TABLE IF NOT EXISTS, every
-- index guarded with IF NOT EXISTS, every policy DROP-then-CREATE so
-- re-running this migration is safe.

CREATE TABLE IF NOT EXISTS bd_account_stars (
  account_id  uuid NOT NULL REFERENCES bd_accounts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  -- Denormalized from bd_accounts so the RLS policy stays a single
  -- leaf-level predicate against the JWT — no subquery into
  -- bd_accounts (which would chain policies and risk Postgres'
  -- recursion detector per the rules in CLAUDE.md / docs/RLS_GOTCHAS.md).
  org_id      uuid NOT NULL DEFAULT public.default_org_id()
                REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

-- Per-user lookup: "all accounts this rep has starred." Used by the
-- "My accounts" filter on the Accounts list and the Top-5 ranking
-- bump on the Today screen.
CREATE INDEX IF NOT EXISTS idx_bd_account_stars_user
  ON bd_account_stars (user_id, account_id);

-- Tenant-isolation index on org_id, mirroring every other bd_* table.
CREATE INDEX IF NOT EXISTS idx_bd_account_stars_org
  ON bd_account_stars (org_id);

ALTER TABLE bd_account_stars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_bd_account_stars_select" ON bd_account_stars;
CREATE POLICY "tenant_isolation_bd_account_stars_select"
  ON bd_account_stars FOR SELECT
  TO authenticated
  USING (
    org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "tenant_isolation_bd_account_stars_insert" ON bd_account_stars;
CREATE POLICY "tenant_isolation_bd_account_stars_insert"
  ON bd_account_stars FOR INSERT
  TO authenticated
  WITH CHECK (
    org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "tenant_isolation_bd_account_stars_delete" ON bd_account_stars;
CREATE POLICY "tenant_isolation_bd_account_stars_delete"
  ON bd_account_stars FOR DELETE
  TO authenticated
  USING (
    org_id  = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND user_id = (SELECT auth.uid())
  );

-- Note: no UPDATE policy. Star rows have no editable columns —
-- they're created or deleted, never modified.

DROP POLICY IF EXISTS "service_role_full_access_bd_account_stars" ON bd_account_stars;
CREATE POLICY "service_role_full_access_bd_account_stars"
  ON bd_account_stars FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE bd_account_stars IS
  'Per-user personal favorites on bd_accounts. Stars are private — '
  'each row is visible only to the user_id that owns it (enforced via '
  'RLS). Used by the BD portal''s "My accounts" filter and the Today-'
  'screen ranking bump. May later coexist with team-visible account '
  'assignment via an additive role column.';
