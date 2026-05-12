-- Phase 1.5 — ai_suggestion_grades table.
--
-- Retrospective grading surface. The proactive_planner and inbound_router
-- agents have written months of `ai_suggestions` rows that operators
-- never acted on ("implicit shadow mode"). Phase 2's autonomy work on
-- the recruiting funnel needs a calibration set; this table is where
-- the owner records that calibration verdict-by-verdict.
--
-- Append-only by design. Re-grading the same suggestion writes a new
-- row; the "current" grade for a suggestion is the row with the
-- largest `graded_at`. Old grades stay for audit (no UPDATE, no
-- DELETE — same posture as `agent_versions` and `agent_actions`).
--
-- Three verdicts, mapped onto the autonomy-v2 signal in the runtime
-- (see `supabase/functions/_shared/operations/autonomy.ts`):
--   * 'good'     → counts as a positive signal (phase=confirmed)
--   * 'bad'      → counts as a negative signal (phase=rejected)
--   * 'harmful'  → triggers immediate one-level demote (severity flag)
--
-- RLS posture mirrors `agent_actions` (Phase 1.1.A): SELECT for any
-- same-org authenticated user; INSERT/UPDATE/DELETE blocked at the
-- table level and routed through `upsert_ai_suggestion_grade_v1`
-- (SECURITY DEFINER, admin-gated, next migration). Service role
-- bypasses RLS for migrations and ad-hoc admin queries.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, REVOKE is a no-op if the
-- privilege is absent. Safe to re-run via `supabase db push`.

CREATE TABLE IF NOT EXISTS public.ai_suggestion_grades (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy. Defaulted to Tremendous Care's org via `default_org_id()`
  -- so service-role inserts (the RPC) inherit it automatically.
  org_id          uuid NOT NULL DEFAULT public.default_org_id()
                    REFERENCES public.organizations(id),

  -- The suggestion being graded. CASCADE so deleting a suggestion
  -- cleans up its grades (no orphan grade history).
  suggestion_id   uuid NOT NULL REFERENCES public.ai_suggestions(id) ON DELETE CASCADE,

  -- The verdict. Locked to three values per the spec.
  verdict         text NOT NULL CHECK (verdict IN ('good', 'bad', 'harmful')),

  -- Optional free-text reasoning. Empty string and NULL both treated as
  -- "no rationale" by the UI.
  rationale       text,

  -- Who graded it. Format mirrors `events.actor` and
  -- `agent_actions.actor` — typically `user:<email>` or `system:<source>`.
  graded_by       text NOT NULL CHECK (length(graded_by) > 0),
  graded_at       timestamptz NOT NULL DEFAULT now()
);

-- Index for "give me the latest grade per suggestion" queries (the
-- grading UI + the autonomy v2 merger both need this).
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_grades_suggestion
  ON public.ai_suggestion_grades (suggestion_id, graded_at DESC);

-- Index for org-scoped browsing in the grading UI (filter by date).
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_grades_org_time
  ON public.ai_suggestion_grades (org_id, graded_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- RLS — strict tenant isolation, SELECT-only for authenticated.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.ai_suggestion_grades ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_predicate constant text :=
    'org_id = nullif(auth.jwt() ->> ''org_id'', '''')::uuid';
BEGIN
  -- SELECT — same-org authenticated. Admin-only views (the grading UI)
  -- enforce admin gating in the React route guard, not here, because
  -- non-admin reads of grading history are harmless (it's commentary
  -- on agent suggestions) and the page itself is admin-gated upstream.
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_ai_suggestion_grades_select ON public.ai_suggestion_grades';
  EXECUTE format(
    'CREATE POLICY tenant_isolation_ai_suggestion_grades_select ON public.ai_suggestion_grades '
    || 'FOR SELECT TO authenticated USING (%s)',
    v_predicate
  );
  -- INSERT/UPDATE/DELETE: no policies + REVOKE below. Writes go through
  -- upsert_ai_suggestion_grade_v1 (SECURITY DEFINER, next migration).
END
$$;

-- Lockdown: revoke direct write privileges from authenticated. The
-- RPC runs as the function owner (postgres) and is unaffected.
REVOKE INSERT, UPDATE, DELETE ON public.ai_suggestion_grades FROM authenticated;

-- Sanity: confirm the lockdown landed.
DO $$
DECLARE
  v_bad_count integer;
BEGIN
  SELECT count(*) INTO v_bad_count
    FROM information_schema.table_privileges
   WHERE grantee = 'authenticated'
     AND table_schema = 'public'
     AND table_name = 'ai_suggestion_grades'
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');

  IF v_bad_count <> 0 THEN
    RAISE EXCEPTION
      'ai_suggestion_grades lockdown failed: authenticated still has % write privileges',
      v_bad_count;
  END IF;
END
$$;

COMMENT ON TABLE public.ai_suggestion_grades IS
  'Phase 1.5: retrospective grades on ai_suggestions. Append-only; '
  'latest graded_at per suggestion_id is the "current" verdict. '
  'Writes via upsert_ai_suggestion_grade_v1 RPC only.';
