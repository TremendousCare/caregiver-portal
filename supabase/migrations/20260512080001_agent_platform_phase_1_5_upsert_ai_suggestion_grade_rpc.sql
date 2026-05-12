-- Phase 1.5 — upsert_ai_suggestion_grade_v1 RPC.
--
-- Sole write path into `ai_suggestion_grades` from the admin grading
-- UI. Append-only: every call inserts a new row even when re-grading
-- the same suggestion. The "current" grade for a suggestion is
-- (suggestion_id, MAX(graded_at)).
--
-- Behaviour:
--   * Admin-only via `public.is_admin()` (same SECURITY DEFINER helper
--     the toggle_agent_flag_v1 RPC uses).
--   * Tenant isolation via the JWT `org_id` claim — the target
--     suggestion's org_id must match the caller's claim.
--   * Validates verdict in ('good', 'bad', 'harmful') at the RPC layer
--     in addition to the CHECK constraint, so callers get a clear
--     22023 error instead of a cryptic constraint-violation.
--   * Writes an `events` row with event_type='ai_suggestion_graded'
--     so the audit trail in the events bus shows who graded what and
--     why. (Not agent_actions — the hash-chained audit log only
--     captures decisions made BY an agent; this row is an operator
--     judgement ABOUT an agent's prior decision.)
--   * Returns the new grade's id so the UI can optimistically render.
--
-- Recursion safety: SECURITY DEFINER + inner `is_admin()` is also
-- SECURITY DEFINER, so neither evaluates user_roles RLS during the
-- admin check. Same pattern documented on toggle_agent_flag_v1.
--
-- Granted to `authenticated` so the React page can call it; the
-- admin gate inside is what restricts the call.

CREATE OR REPLACE FUNCTION public.upsert_ai_suggestion_grade_v1(
  p_suggestion_id uuid,
  p_verdict       text,
  p_rationale     text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_email   text;
  v_jwt_org_id    uuid;
  v_suggestion    record;
  v_grade_id      uuid;
  v_actor         text;
BEGIN
  -- 1. Admin-only.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied: not an admin' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate inputs.
  IF p_suggestion_id IS NULL THEN
    RAISE EXCEPTION 'p_suggestion_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_verdict IS NULL OR p_verdict NOT IN ('good', 'bad', 'harmful') THEN
    RAISE EXCEPTION 'invalid verdict: %', p_verdict USING ERRCODE = '22023';
  END IF;

  -- 3. Resolve the caller's org from the JWT.
  v_jwt_org_id := nullif(auth.jwt() ->> 'org_id', '')::uuid;
  IF v_jwt_org_id IS NULL THEN
    RAISE EXCEPTION 'JWT missing org_id claim' USING ERRCODE = '42501';
  END IF;

  -- 4. Load the suggestion and verify the caller's org owns it.
  SELECT s.id, s.org_id, s.action_type, s.agent_id INTO v_suggestion
    FROM public.ai_suggestions s
   WHERE s.id = p_suggestion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'suggestion not found: %', p_suggestion_id USING ERRCODE = 'P0002';
  END IF;
  IF v_suggestion.org_id <> v_jwt_org_id THEN
    RAISE EXCEPTION 'permission denied: suggestion org mismatch' USING ERRCODE = '42501';
  END IF;

  -- 5. Identify the actor.
  v_actor_email := lower((auth.jwt() ->> 'email'));
  v_actor       := 'user:' || coalesce(v_actor_email, 'unknown');

  -- 6. Append a new grade row. No UPDATE — re-grading a suggestion
  --    writes a new row; old rows stay for audit.
  INSERT INTO public.ai_suggestion_grades (
    org_id, suggestion_id, verdict, rationale, graded_by
  ) VALUES (
    v_suggestion.org_id,
    p_suggestion_id,
    p_verdict,
    nullif(p_rationale, ''),
    v_actor
  )
  RETURNING id INTO v_grade_id;

  -- 7. Audit row in events. Stamped with the agent_id from the
  --    suggestion so the per-agent metrics dashboard can correlate
  --    grading activity with the agent under review. entity_type/id
  --    NULL because grading is suggestion-scoped, not entity-scoped
  --    (the events.entity_type CHECK only allows caregiver/client).
  INSERT INTO public.events (
    org_id, agent_id, event_type, entity_type, entity_id, actor, payload
  ) VALUES (
    v_suggestion.org_id,
    v_suggestion.agent_id,
    'ai_suggestion_graded',
    NULL,
    NULL,
    v_actor,
    jsonb_build_object(
      'suggestion_id', p_suggestion_id,
      'grade_id',      v_grade_id,
      'verdict',       p_verdict,
      'action_type',   v_suggestion.action_type,
      'has_rationale', (p_rationale IS NOT NULL AND length(p_rationale) > 0)
    )
  );

  RETURN v_grade_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.upsert_ai_suggestion_grade_v1(uuid, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.upsert_ai_suggestion_grade_v1(uuid, text, text) TO authenticated;

-- Sanity check: confirm the function landed and is SECURITY DEFINER.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'upsert_ai_suggestion_grade_v1'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'public.upsert_ai_suggestion_grade_v1 missing or not SECURITY DEFINER after migration';
  END IF;
END
$$;

COMMENT ON FUNCTION public.upsert_ai_suggestion_grade_v1(uuid, text, text) IS
  'Phase 1.5: admin-only append-only grade write. Inserts a row in '
  'ai_suggestion_grades and an audit row in events. Re-grading the '
  'same suggestion appends a new row; latest graded_at wins.';
