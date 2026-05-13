-- BD Module — route plans (manual route builder)
--
-- Adds a per-rep daily route plan: a hand-curated, ordered list of
-- bd_accounts the rep intends to visit on a given day. Pairs with the
-- multi-stop Apple Maps URL builder shipped in #325 (auto-generated
-- from Top-5) by giving Amy control over the stop list when the
-- algorithmic Top-5 isn't quite right.
--
-- New table:
--   - bd_route_plans(id, org_id, owner_user_id, plan_date, name,
--                    stops jsonb, status). Stops are stored as a
--                    JSONB array of { account_id, position } so the
--                    list reorders with a single UPDATE and a stop
--                    can carry future fields (notes, completed_at)
--                    without a schema migration. account_id values
--                    are not FK-enforced — the frontend resolves them
--                    against the accounts list and drops stale ids.
--
-- Constraint:
--   One ACTIVE plan per (org, user, plan_date). Archived plans stay
--   for audit. Enforced by a partial unique index.
--
-- Visibility model:
--   Route plans are PERSONAL data. The RLS policy gates on
--   owner_user_id = auth.uid() OR public.is_admin() so a rep cannot
--   see another rep's plan. Both branches are leaf-level checks (no
--   subquery into bd_route_plans, no cross-table EXISTS), which keeps
--   us clear of the Postgres policy-recursion footgun documented in
--   docs/RLS_GOTCHAS.md.
--
-- Tenant isolation:
--   Standard SaaS retrofit Phase B pattern — org_id NOT NULL DEFAULT
--   default_org_id() REFERENCES organizations(id), four
--   permissive tenant_isolation_<table>_<cmd> policies + a
--   service_role_full_access policy. The tenant policies OR in the
--   admin clause so org admins can see route plans across the team
--   without a separate "admin_full_access" policy stack.
--
-- Production safety:
--   Pure additive DDL. No DROP TABLE, no DELETE, no destructive
--   ALTER. IF NOT EXISTS / DROP POLICY IF EXISTS guards throughout so
--   the deploy workflow can replay safely. Rollback at
--   _rollback/20260513150000_bd_route_plans_down.sql.

CREATE TABLE IF NOT EXISTS bd_route_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT public.default_org_id()
                    REFERENCES organizations(id) ON DELETE RESTRICT,
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_date       date NOT NULL,
  -- Optional friendly label (e.g. "South OC + UCI swing"). Defaults
  -- to NULL — the rep almost never names a plan; the date is the key.
  name            text,
  -- Ordered list of { account_id: uuid, position: int }. Position is
  -- redundant with array order today; we store it explicitly so a
  -- future drag-and-drop UI can reorder by editing position without
  -- rewriting the whole array atomically. account_id is not
  -- FK-enforced — the frontend tolerates and prunes stale references.
  stops           jsonb NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(stops) = 'array'),
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One active plan per rep per day. Archived plans are unconstrained
-- so the rep can roll a plan over to a new date by archiving the old
-- one and inserting a fresh row.
CREATE UNIQUE INDEX IF NOT EXISTS bd_route_plans_active_per_day
  ON bd_route_plans (org_id, owner_user_id, plan_date)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_bd_route_plans_owner_date
  ON bd_route_plans (owner_user_id, plan_date DESC);

CREATE INDEX IF NOT EXISTS idx_bd_route_plans_org
  ON bd_route_plans (org_id);

ALTER TABLE bd_route_plans ENABLE ROW LEVEL SECURITY;

-- All four user policies share the same predicate:
--   org match AND (own row OR admin)
-- This is two leaf clauses (auth.uid() = column, is_admin() RPC) plus
-- an org_id equality. No cross-table EXISTS into bd_route_plans, so
-- the policy-recursion detector cannot trip on it even after the
-- table accumulates more policies later.

DROP POLICY IF EXISTS "tenant_isolation_bd_route_plans_select" ON bd_route_plans;
CREATE POLICY "tenant_isolation_bd_route_plans_select"
  ON bd_route_plans FOR SELECT
  TO authenticated
  USING (
    org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND (owner_user_id = auth.uid() OR public.is_admin())
  );

DROP POLICY IF EXISTS "tenant_isolation_bd_route_plans_insert" ON bd_route_plans;
CREATE POLICY "tenant_isolation_bd_route_plans_insert"
  ON bd_route_plans FOR INSERT
  TO authenticated
  WITH CHECK (
    org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND (owner_user_id = auth.uid() OR public.is_admin())
  );

DROP POLICY IF EXISTS "tenant_isolation_bd_route_plans_update" ON bd_route_plans;
CREATE POLICY "tenant_isolation_bd_route_plans_update"
  ON bd_route_plans FOR UPDATE
  TO authenticated
  USING      (
    org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND (owner_user_id = auth.uid() OR public.is_admin())
  )
  WITH CHECK (
    org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND (owner_user_id = auth.uid() OR public.is_admin())
  );

DROP POLICY IF EXISTS "tenant_isolation_bd_route_plans_delete" ON bd_route_plans;
CREATE POLICY "tenant_isolation_bd_route_plans_delete"
  ON bd_route_plans FOR DELETE
  TO authenticated
  USING (
    org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    AND (owner_user_id = auth.uid() OR public.is_admin())
  );

DROP POLICY IF EXISTS "service_role_full_access_bd_route_plans" ON bd_route_plans;
CREATE POLICY "service_role_full_access_bd_route_plans"
  ON bd_route_plans FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS bd_route_plans_set_updated_at ON bd_route_plans;
CREATE TRIGGER bd_route_plans_set_updated_at
  BEFORE UPDATE ON bd_route_plans
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
