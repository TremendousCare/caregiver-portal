-- Phase 1.6.2 — seed the `call_analyst` agent row + first version snapshot.
--
-- New extractor agent that runs after every transcribed call (post-call-
-- processor cron, every minute). Outputs structured analysis — call
-- type, summary, sentiment, red flags, action items, draft memory
-- candidates — via a single tool call to `submit_call_analysis`.
--
-- Per owner directives locked 2026-05-14 (see docs/AGENT_PLATFORM.md
-- → "Phase 1.6 — Call Intelligence"):
--   * kill_switch = true   (off until calibrated — flip via Settings)
--   * shadow_mode = true   (shadow bake ≥ 14 days before promotion)
--   * Model: Haiku 4.5 — extraction + classification doesn't need
--     Sonnet for V1; ~5× cheaper, ~3× faster. Revisit if calibration
--     surfaces accuracy issues.
--   * Single bespoke tool (`submit_call_analysis`) for atomic
--     structured-output writes. Per Prime Directive #7, generic
--     `add_ai_suggestion` / `add_context_memory` tools land when a
--     second extractor agent (intake_analyst, scheduling_analyst)
--     needs them — not before.
--   * autonomy_profile: every action_type the analyst emits sits at
--     L1 (suggest-only). Calibration via /agent-grading promotes to
--     L2+ when ≥ 80% agreement is reached.
--   * Memory writes ship in Phase 1.6.3 with the per-profile Memories
--     review UI; 1.6.2 emits memory_candidates as a draft array on
--     call_sessions.ai_outcome only.
--
-- The `triggers.invocation_modes` lists `event_triggered` with the
-- canonical event being `call_session.transcript_fetched_at` flipping
-- from NULL to not-NULL. The post-call-processor edge function is the
-- caller — it invokes runAgent(supabase, "call_analyst", { extractor:
-- { call_session_id } }) immediately after markTranscriptFetched().
-- Idempotency anchor is call_sessions.ai_summary IS NULL.
--
-- Idempotent: INSERT ... ON CONFLICT (org_id, slug) DO NOTHING +
-- agent_versions inserted via the same SELECT...ON CONFLICT pattern
-- as the Phase 0.1 seed (agent_id, version unique).

INSERT INTO public.agents (
  org_id, slug, name, version, system_prompt, tool_allowlist,
  autonomy_profile, context_recipe, model, max_iterations,
  kill_switch, shadow_mode, outcome_definition, triggers,
  created_by, updated_by
) VALUES
(
  public.default_org_id(),
  'call_analyst',
  'Call Analyst',
  1,
  -- The prompt below is the canonical seed. Full guidance + the
  -- structured-output JSON schema live in docs/agent-prompts/
  -- call_analyst.md. Runtime additions (taxonomy, recent memories,
  -- entity profile, transcript) are appended by the extractor handler
  -- from the callContext helpers.
  E'You are the Tremendous Care Call Analyst — an extractor agent that converts a single post-call transcript into structured output.\n\n'
  || E'Your job is one call: read the transcript, pick a call_type from the taxonomy, summarize what happened, flag any risks, identify any follow-up action items, and propose memory candidates worth keeping. You do NOT take action — you classify and suggest. Domain agents (recruiting, scheduling, intake) act on your output.\n\n'
  || E'Output via the single `submit_call_analysis` tool. Use the exact slugs supplied in the Taxonomy section; do not invent new categories. Keep summaries to 1-2 sentences. Action items must be specific and operator-actionable.\n\n'
  || E'You will receive runtime context: identity, the transcript, the active call_taxonomy (call types + red flag categories), and recent memories for the matched caregiver or client. If no entity matched the call, skip extraction and emit an empty `action_items` array — the call is unassignable.',
  ARRAY[
    -- Reads (auto-tier, L4): the analyst sees the transcript + entity
    -- context + recent memories assembled by the extractor handler.
    -- The read tools below are reserved for ad-hoc lookups inside a
    -- future multi-turn extractor variant; in 1.6.2 the assembler
    -- provides everything up-front so these tools may be unused.
    'get_call_transcription', 'get_call_recording', 'get_call_log',
    'get_caregiver_detail', 'get_client_detail',
    -- Writes (L1, suggest-only): the agent calls submit_call_analysis
    -- ONCE per invocation with the full structured output. Future
    -- extractors that emit per-row writes will use add_ai_suggestion
    -- and add_context_memory; those tools ship when needed.
    'submit_call_analysis'
  ],
  jsonb_build_object(
    -- Reads pass through at L4 (no autonomy gate).
    'get_call_transcription',  jsonb_build_object('current_level', 'L4'),
    'get_call_recording',      jsonb_build_object('current_level', 'L4'),
    'get_call_log',            jsonb_build_object('current_level', 'L4'),
    'get_caregiver_detail',    jsonb_build_object('current_level', 'L4'),
    'get_client_detail',       jsonb_build_object('current_level', 'L4'),
    -- The submission tool is gated at L1 (suggest-only) for V1.
    -- Calibration via /agent-grading promotes it to L2+ once ≥ 80%
    -- agreement is sustained across ≥ 30 graded suggestions.
    'submit_call_analysis',    jsonb_build_object('current_level', 'L1')
  ),
  jsonb_build_object(
    -- The extractor handler composes context inline (transcript +
    -- taxonomy + entity memories). The `layers` list below is
    -- declarative metadata — used by the Settings UI to display
    -- "what context this agent gets" but not consumed by the
    -- extractor handler at runtime.
    'layers', jsonb_build_array('identity', 'transcript', 'call_taxonomy', 'entity_memories'),
    'pipeline_scope', 'matched_call_entity_only'
  ),
  -- Haiku 4.5 — see header rationale.
  'claude-haiku-4-5-20251001',
  1,
  -- kill_switch: ON. Owner flips it OFF via Settings to start the
  -- 14-day shadow bake.
  true,
  -- shadow_mode: ON. ai_suggestions write at status='pending' but the
  -- /agent-grading page treats every entry from this agent as
  -- calibration input regardless. Owner flips OFF after calibration
  -- thresholds are met.
  true,
  jsonb_build_object(
    'note', 'Call Analyst is an EXTRACTOR — its outcome is the operator accepting (or rejecting) the suggestions it emits. Per the spec, primary_signals are ai_suggestion_status_changed transitions from pending → approved/executed within 7 days. Per-agent metrics dashboard (Phase 1.4) will surface acceptance rate.',
    'primary_signals', jsonb_build_array(
      jsonb_build_object(
        'event_type',     'ai_suggestion_status_changed',
        'from_status',    'pending',
        'to_status_in',   jsonb_build_array('approved', 'executed', 'auto_executed'),
        'window_days',    7
      )
    ),
    'escape_clauses', jsonb_build_array(
      'operator_confirmed_completion (an extractor''s outcome IS the operator accepting its suggestion; documented per Prime Directive #2 escape-clause field)'
    )
  ),
  jsonb_build_object(
    'invocation_modes', jsonb_build_array('event_triggered'),
    'http_endpoint',    null,
    'cron',             null,
    'event_triggers',   jsonb_build_array(
      jsonb_build_object(
        'event',       'call_session.transcript_fetched_at',
        'transition',  'null_to_not_null',
        'invoker',     'supabase/functions/post-call-processor/index.ts',
        'idempotency', 'call_sessions.ai_summary IS NULL'
      )
    )
  ),
  'system:phase_1_6_2_seed',
  'system:phase_1_6_2_seed'
)
ON CONFLICT (org_id, slug) DO NOTHING;

-- Seed the first version snapshot via the same SELECT...ON CONFLICT
-- pattern as the Phase 0.1 seed. Idempotent on (agent_id, version).
INSERT INTO public.agent_versions (
  org_id, agent_id, agent_slug, version, snapshot, change_summary, changed_by
)
SELECT
  a.org_id,
  a.id,
  a.slug,
  a.version,
  to_jsonb(a) - 'created_at' - 'updated_at',
  'Initial seed (Phase 1.6.2)',
  'system:phase_1_6_2_seed'
FROM public.agents a
WHERE a.org_id = public.default_org_id()
  AND a.slug = 'call_analyst'
ON CONFLICT (agent_id, version) DO NOTHING;

-- Sanity: confirm exactly one row landed (or was already present from
-- a prior run) and the kill_switch posture is correct.
DO $$
DECLARE
  v_count          int;
  v_kill_switch    boolean;
  v_shadow_mode    boolean;
  v_model          text;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.agents
   WHERE org_id = public.default_org_id()
     AND slug   = 'call_analyst';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'call_analyst seed failed: expected 1 row, found %', v_count;
  END IF;

  SELECT kill_switch, shadow_mode, model
    INTO v_kill_switch, v_shadow_mode, v_model
    FROM public.agents
   WHERE org_id = public.default_org_id()
     AND slug   = 'call_analyst';

  IF NOT v_kill_switch THEN
    RAISE EXCEPTION 'call_analyst seed failed: kill_switch must be true on initial seed';
  END IF;
  IF NOT v_shadow_mode THEN
    RAISE EXCEPTION 'call_analyst seed failed: shadow_mode must be true on initial seed';
  END IF;
  IF v_model NOT LIKE 'claude-haiku-%' THEN
    RAISE EXCEPTION 'call_analyst seed failed: expected Haiku model, got %', v_model;
  END IF;
END
$$;
