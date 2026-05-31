-- ═══════════════════════════════════════════════════════════════
-- Care Coordinator Agent — M1: seed the agent manifest
--
-- Idempotent seed of the care_coordinator agent in the existing
-- public.agents registry, mirroring the Phase 1.6.2 call_analyst seed
-- (the canonical "new agent" pattern). (org_id, slug) is the natural
-- key so re-runs are safe.
--
-- NOTE: slug must match agents_slug_format CHECK (^[a-z][a-z0-9_]*$) —
-- hence `care_coordinator` (underscore, NOT a hyphen). The detector
-- edge function looks the agent up by this exact slug.
--
-- Gating: kill_switch = true (OFF) on initial seed, per the convention
-- for new agents — the detector no-ops until an operator flips it off
-- via Settings. shadow_mode = true so early output is treated as
-- calibration input. The detector's two-window + threshold config
-- lives in context_recipe (read by the sweep), since agents has no
-- free-form `config` column.
--
-- Behavior-neutral: nothing dispatches this agent yet (the sweep cron
-- ships in M2 and itself respects kill_switch).
-- ═══════════════════════════════════════════════════════════════

INSERT INTO public.agents (
  org_id, slug, name, version, system_prompt, tool_allowlist,
  autonomy_profile, context_recipe, model, max_iterations,
  kill_switch, shadow_mode, outcome_definition, triggers,
  created_by, updated_by
) VALUES
(
  public.default_org_id(),
  'care_coordinator',
  'Care Coordinator',
  1,
  -- Canonical seed prompt. The sweep's prompt builder
  -- (care-coordinator-sweep/prompt.ts) composes the full runtime prompt
  -- (Stop-and-Watch rubric, SBAR contract, the client's baseline +
  -- acute observations); this stored prompt documents the agent's role.
  E'You are the Tremendous Care Care Coordinator — a read-only clinical-surveillance agent.\n\n'
  || E'For one client at a time you read recent caregiver-logged shift observations and compare them to that client''s own baseline (care plan + recent normal). Your job is to decide whether there is a CLUSTER of changes that a human should review today as a possible change of condition, using the validated Stop-and-Watch early-warning categories.\n\n'
  || E'Hard rules: judge relative to THIS client''s baseline; require a cluster, not a single data point; default to silence; this is decision support, never diagnosis — recommendations are always "recommend a nurse/office review", never orders; ground every signal in the actual observations you were given.',
  -- Read-only: the detector calls no tools (it uses a single structured
  -- output), so the allowlist is empty. No outward actions, by design.
  ARRAY[]::text[],
  '{}'::jsonb,
  -- context_recipe carries the v1 behavior contract the sweep reads:
  jsonb_build_object(
    'acute_window_days', 7,
    'baseline_window_days', 30,
    'severity_thresholds', jsonb_build_object(
      'watch_min_categories', 2,
      'urgent_min_categories', 3
    ),
    'layers', jsonb_build_array('identity', 'care_plan_baseline', 'recent_observations'),
    'pipeline_scope', 'active_care_plan_clients_only'
  ),
  'claude-sonnet-4-5-20250929',
  1,
  -- kill_switch: ON. Operator flips OFF via Settings to start surfacing
  -- signals once there's a UI to review them (M3).
  true,
  -- shadow_mode: ON. Early signals are calibration input until the
  -- owner is satisfied with precision.
  true,
  jsonb_build_object(
    'note', 'Care Coordinator is a surveillance detector — its outcome is whether a surfaced care_signal was acted on vs dismissed by staff. Per-signal disposition (acknowledged/actioned/dismissed) is the primary calibration signal.',
    'primary_signals', jsonb_build_array(
      jsonb_build_object(
        'event_type',   'care_signal_dispositioned',
        'window_days',  7
      )
    )
  ),
  jsonb_build_object(
    'invocation_modes', jsonb_build_array('cron'),
    'http_endpoint',    null,
    'cron',             'every 4 hours (care-coordinator-sweep)',
    'event_triggers',   jsonb_build_array()
  ),
  'system:care_coordinator_m1_seed',
  'system:care_coordinator_m1_seed'
)
ON CONFLICT (org_id, slug) DO NOTHING;

-- First version snapshot, same pattern as the Phase 0.1 / 1.6.2 seeds.
-- Idempotent on (agent_id, version).
INSERT INTO public.agent_versions (
  org_id, agent_id, agent_slug, version, snapshot, change_summary, changed_by
)
SELECT
  a.org_id,
  a.id,
  a.slug,
  a.version,
  to_jsonb(a) - 'created_at' - 'updated_at',
  'Initial seed (Care Coordinator M1)',
  'system:care_coordinator_m1_seed'
FROM public.agents a
WHERE a.org_id = public.default_org_id()
  AND a.slug = 'care_coordinator'
ON CONFLICT (agent_id, version) DO NOTHING;

-- Sanity: exactly one row, gated OFF.
DO $$
DECLARE
  v_count       int;
  v_kill_switch boolean;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.agents
   WHERE org_id = public.default_org_id() AND slug = 'care_coordinator';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'care_coordinator seed failed: expected 1 row, found %', v_count;
  END IF;

  SELECT kill_switch INTO v_kill_switch
    FROM public.agents
   WHERE org_id = public.default_org_id() AND slug = 'care_coordinator';
  IF NOT v_kill_switch THEN
    RAISE EXCEPTION 'care_coordinator seed failed: kill_switch must be true on initial seed';
  END IF;
END
$$;
