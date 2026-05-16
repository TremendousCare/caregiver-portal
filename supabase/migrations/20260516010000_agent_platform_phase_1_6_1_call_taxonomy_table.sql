-- Phase 1.6.1 — call_taxonomy table.
--
-- Editable categorisation rows that the future `call_analyst` agent
-- (Phase 1.6.2) will use to classify transcripts. Two axes:
--   * 'call_type'  — what kind of call this is (recruiting, payroll, ...)
--   * 'red_flag'   — categories of risk the agent should flag for
--                    operator attention (safety_issue, legal_or_hr_risk, ...)
--
-- Per the Phase 1.6 spec (docs/AGENT_PLATFORM.md → "Owner directives
-- locked"), the taxonomy is DATA, not code. No Tremendous-Care-specific
-- strings live in the schema; rows are seeded in a separate migration
-- and editable from the admin Settings UI. Multi-tenant from day one
-- (every row is org_id-scoped) so adding a new tenant in Phase D means
-- inserting their taxonomy rows, not a schema change.
--
-- Versioning posture: this table is editable in place. Phase 1.6.2's
-- `call_analyst` manifest will reference the taxonomy by slug; a
-- manifest change there bumps `agents.version` and lands in
-- `agent_versions` via the existing Phase 0.5 path. The taxonomy
-- itself does NOT keep a version history — operator edits are
-- treated like message-template / automation-rule edits. If we ever
-- need an audit trail of taxonomy changes we add an `events` row in
-- the RPC; not needed for V1.
--
-- RLS posture mirrors `ai_suggestion_grades` (Phase 1.5):
--   * SELECT for any same-org authenticated user (the taxonomy is
--     reference data; non-admins reading it is harmless).
--   * INSERT/UPDATE/DELETE blocked at table level via REVOKE; routed
--     through `upsert_call_taxonomy_row_v1` (SECURITY DEFINER,
--     admin-gated, next migration).
--   * Service role bypasses RLS for migrations and ad-hoc queries.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, REVOKE is a no-op if the
-- privilege is absent. Safe to re-run via `supabase db push`.

CREATE TABLE IF NOT EXISTS public.call_taxonomy (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy. Defaulted so service-role inserts (RPC + seed migration)
  -- inherit it without specifying explicitly.
  org_id          uuid NOT NULL DEFAULT public.default_org_id()
                    REFERENCES public.organizations(id),

  -- Two-axis: call_type | red_flag. Locked enum — adding a third axis
  -- in the future is an additive schema change in this column's CHECK.
  axis            text NOT NULL CHECK (axis IN ('call_type', 'red_flag')),

  -- Stable machine identifier. The agent manifest's prompt references
  -- the taxonomy by slug, so renaming the slug invalidates downstream
  -- references. Label / description / sort_order edit freely.
  slug            text NOT NULL CHECK (length(slug) > 0),

  -- Display name shown in the Settings UI and in agent prompts.
  label           text NOT NULL CHECK (length(label) > 0),

  -- Optional admin-facing helper text describing when to apply this
  -- category. Empty string and NULL both rendered as "no description"
  -- by the UI.
  description     text,

  -- Sort order within an axis. Operators arrange the list manually;
  -- ties broken by created_at ASC for determinism.
  sort_order      integer NOT NULL DEFAULT 0,

  -- Soft archive. Archived rows still satisfy uniqueness so a slug
  -- can't be reused under a different label; the UI hides them by
  -- default and the agent's prompt only iterates active rows.
  is_active       boolean NOT NULL DEFAULT true,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  updated_by      text,

  -- Slugs are unique within (org_id, axis). Same slug can exist under
  -- different axes (e.g. 'other' in both call_type and red_flag).
  UNIQUE (org_id, axis, slug)
);

-- Per-axis filtered + ordered display is the dominant query.
CREATE INDEX IF NOT EXISTS idx_call_taxonomy_org_axis_sort
  ON public.call_taxonomy (org_id, axis, sort_order, created_at);

-- Partial index for the agent-prompt fetch (only active rows).
CREATE INDEX IF NOT EXISTS idx_call_taxonomy_org_axis_active
  ON public.call_taxonomy (org_id, axis, sort_order)
  WHERE is_active = true;

-- ─────────────────────────────────────────────────────────────────
-- updated_at trigger — reuse the canonical touch helper.
-- ─────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS call_taxonomy_set_updated_at ON public.call_taxonomy;
CREATE TRIGGER call_taxonomy_set_updated_at
  BEFORE UPDATE ON public.call_taxonomy
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- RLS — same-org SELECT for authenticated; writes via RPC only.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.call_taxonomy ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_predicate constant text :=
    'org_id = nullif(auth.jwt() ->> ''org_id'', '''')::uuid';
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_call_taxonomy_select ON public.call_taxonomy';
  EXECUTE format(
    'CREATE POLICY tenant_isolation_call_taxonomy_select ON public.call_taxonomy '
    || 'FOR SELECT TO authenticated USING (%s)',
    v_predicate
  );
END
$$;

-- Service role can do anything (used by the seed migration + ad-hoc).
DROP POLICY IF EXISTS service_role_full_access_call_taxonomy ON public.call_taxonomy;
CREATE POLICY service_role_full_access_call_taxonomy ON public.call_taxonomy
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Lockdown: revoke direct write privileges from authenticated. RPC
-- runs as the function owner and is unaffected.
REVOKE INSERT, UPDATE, DELETE ON public.call_taxonomy FROM authenticated;

-- Sanity check: confirm the lockdown landed.
DO $$
DECLARE
  v_bad_count integer;
BEGIN
  SELECT count(*) INTO v_bad_count
    FROM information_schema.table_privileges
   WHERE grantee = 'authenticated'
     AND table_schema = 'public'
     AND table_name = 'call_taxonomy'
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');

  IF v_bad_count <> 0 THEN
    RAISE EXCEPTION
      'call_taxonomy lockdown failed: authenticated still has % write privileges',
      v_bad_count;
  END IF;
END
$$;

COMMENT ON TABLE public.call_taxonomy IS
  'Phase 1.6.1: editable categorisation rows (call_type + red_flag) '
  'consumed by the call_analyst agent in Phase 1.6.2. Writes via '
  'upsert_call_taxonomy_row_v1 RPC only.';
