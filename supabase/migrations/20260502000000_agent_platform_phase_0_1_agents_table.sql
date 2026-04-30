-- Agent Platform — Phase 0.1: agents + agent_versions tables, seed three rows.
--
-- Part of the Agent Platform (see docs/AGENT_PLATFORM.md → Phase 0.1).
-- This migration is purely additive: two new tables, RLS enabled fail-closed
-- with the same predicate as the SaaS retrofit's B2b policies, and a seed of
-- three rows for Tremendous Care representing today's three implicit agents:
--   * recruiting        — today's ai-chat edge function
--   * proactive_planner — today's ai-planner edge function
--   * inbound_router    — today's message-router edge function
--
-- This migration changes NO behavior. The runtime does not yet read from
-- these tables — that wiring lands in Phase 0.3 (`agentRuntime.ts`) and the
-- edge function cutover in Phase 0.4. Phase 0.1 is the foundation:
-- agents are now first-class data, the seed captures today's behavior, and
-- the version-history table is in place for the Settings UI in Phase 0.5.
--
-- Manifest fields (see docs/AGENT_PLATFORM.md → Architecture target):
--   id, org_id, slug, name, version, system_prompt, tool_allowlist,
--   autonomy_profile, context_recipe, model, max_iterations, kill_switch,
--   shadow_mode, outcome_definition, triggers, plus version metadata.
--
-- The seed populates each row with sensible initial values. Static content
-- (system prompts, tool lists) reflects today's production behavior. Runtime
-- interpolation (today's date, pipeline counts) stays in `runAgent` — the
-- system_prompt column stores the static template only.
--
-- RLS posture: strict / fail-closed, matching the SaaS retrofit's B2b policy
-- pattern. `org_id = nullif(auth.jwt() ->> 'org_id', '')::uuid`. service_role
-- bypasses RLS as elsewhere.
--
-- Predicate naming: tenant_isolation_<table>_<command>, suffix-anchored so it
-- aligns with the regex used by the B2b sanity-check guards.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. agents — first-class agent identity
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL DEFAULT public.default_org_id()
                        REFERENCES public.organizations(id),
  slug                text NOT NULL,
  name                text NOT NULL,
  version             integer NOT NULL DEFAULT 1,

  system_prompt       text NOT NULL,
  tool_allowlist      text[] NOT NULL DEFAULT '{}',
  autonomy_profile    jsonb NOT NULL DEFAULT '{}'::jsonb,
  context_recipe      jsonb NOT NULL DEFAULT '{}'::jsonb,
  model               text NOT NULL DEFAULT 'claude-sonnet-4-5-20250929',
  max_iterations      integer NOT NULL DEFAULT 5,

  -- Per-(agent × org) controls. Both default OFF for the seeded production
  -- agents — the runtime cutover in Phase 0.4 ships agents in their existing
  -- live state. New agents added later (Phase 2+) seed kill_switch = true,
  -- shadow_mode = true and are flipped on by an operator after bake.
  kill_switch         boolean NOT NULL DEFAULT false,
  shadow_mode         boolean NOT NULL DEFAULT false,

  outcome_definition  jsonb NOT NULL DEFAULT '{}'::jsonb,
  triggers            jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text,
  updated_by          text,

  CONSTRAINT agents_slug_per_org_unique UNIQUE (org_id, slug),
  CONSTRAINT agents_version_positive CHECK (version >= 1),
  CONSTRAINT agents_max_iterations_positive CHECK (max_iterations >= 1),
  CONSTRAINT agents_slug_format CHECK (slug ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT agents_model_nonempty CHECK (length(model) > 0),
  CONSTRAINT agents_system_prompt_nonempty CHECK (length(system_prompt) > 0)
);

CREATE INDEX IF NOT EXISTS idx_agents_org_id ON public.agents (org_id);
CREATE INDEX IF NOT EXISTS idx_agents_slug ON public.agents (slug);
CREATE INDEX IF NOT EXISTS idx_agents_kill_switch ON public.agents (org_id, kill_switch)
  WHERE kill_switch = false;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. agent_versions — append-only history of every manifest change
-- ─────────────────────────────────────────────────────────────────────────
--
-- One row per change. Stores a full snapshot, not a diff, so the manifest
-- can be reconstructed at any past version without replay. Revert from the
-- Settings UI = "copy snapshot N back into agents and bump version to N+1".

CREATE TABLE IF NOT EXISTS public.agent_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL DEFAULT public.default_org_id()
                        REFERENCES public.organizations(id),
  agent_id            uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  agent_slug          text NOT NULL,
  version             integer NOT NULL,
  snapshot            jsonb NOT NULL,
  change_summary      text,
  changed_by          text,
  changed_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_versions_unique_per_agent UNIQUE (agent_id, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_org_id
  ON public.agent_versions (org_id);
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_changed_at
  ON public.agent_versions (agent_id, changed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. RLS — strict / fail-closed, matching the B2b pattern
-- ─────────────────────────────────────────────────────────────────────────
--
-- These policies follow the suffix-anchored naming
-- (tenant_isolation_<table>_<select|insert|update|delete>) used by every
-- B2b policy. The B2b sanity-check regex in pg_policy will count these too,
-- so the count check in any future B-cleanup must be aware. For Phase 0.1,
-- the only thing that matters is they exist and they fail closed.

ALTER TABLE public.agents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_versions  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_predicate constant text :=
    'org_id = nullif(auth.jwt() ->> ''org_id'', '''')::uuid';
  v_target text;
BEGIN
  FOREACH v_target IN ARRAY ARRAY['agents', 'agent_versions'] LOOP
    -- SELECT
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_isolation_' || v_target || '_select', v_target
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
      'tenant_isolation_' || v_target || '_select', v_target, v_predicate
    );

    -- INSERT
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_isolation_' || v_target || '_insert', v_target
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)',
      'tenant_isolation_' || v_target || '_insert', v_target, v_predicate
    );

    -- UPDATE
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_isolation_' || v_target || '_update', v_target
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
      'tenant_isolation_' || v_target || '_update', v_target, v_predicate, v_predicate
    );

    -- DELETE
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_isolation_' || v_target || '_delete', v_target
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (%s)',
      'tenant_isolation_' || v_target || '_delete', v_target, v_predicate
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. updated_at trigger on agents
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_agents_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agents_set_updated_at ON public.agents;
CREATE TRIGGER agents_set_updated_at
  BEFORE UPDATE ON public.agents
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_agents_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Seed — three rows for Tremendous Care
-- ─────────────────────────────────────────────────────────────────────────
--
-- Each seed represents an agent that is already operating in production
-- today, just as a hand-coded edge function rather than a manifest row.
-- Phase 0.4's edge function cutover will route those functions through
-- runAgent(slug, ...) and the manifests below become authoritative.
--
-- Tool allowlists below were extracted from the production code paths:
--   * recruiting     — every tool registered by ai-chat (40 total)
--   * proactive_planner — actions emittable by ai-planner via executeSuggestion
--   * inbound_router — actions in VALID_ACTIONS in _shared/operations/routing.ts
--
-- Autonomy profile per action is initialised at the level used today by the
-- corresponding `autonomy_config.context` entries. The v2 promotion algorithm
-- (per-transition thresholds + sliding window + min-sample) lands in Phase
-- 1.2 and rewrites this JSONB. For 0.1, the shape is intentionally minimal:
--   { "<action>": { "current_level": "L1|L2|L3|L4" } }

INSERT INTO public.agents (
  org_id, slug, name, version, system_prompt, tool_allowlist,
  autonomy_profile, context_recipe, model, max_iterations,
  kill_switch, shadow_mode, outcome_definition, triggers,
  created_by, updated_by
) VALUES
-- ── recruiting ────────────────────────────────────────────────────────
(
  public.default_org_id(),
  'recruiting',
  'Recruiting Agent',
  1,
  'You are the Tremendous Care AI Assistant — a smart recruiter copilot built into the Caregiver Portal. You have access to tools that let you search, analyze, and modify caregiver and client data. USE YOUR TOOLS for any data lookups — do not guess or make up data. Be concise and actionable. Use names, not IDs. Format with markdown. Runtime data (today''s date, pipeline stats, currently-viewed entity, situational awareness, relevant memory, active threads, full guidelines) is appended by the runtime context recipe — do not assume any specific values are present at template-render time.',
  ARRAY[
    -- caregiver-read
    'search_caregivers', 'get_caregiver_detail', 'get_pipeline_stats', 'list_stale_leads', 'check_compliance',
    -- caregiver-write
    'add_note', 'draft_message', 'update_phase', 'complete_task', 'update_caregiver_field', 'update_board_status',
    -- communication
    'send_sms', 'get_sms_history', 'get_call_log', 'get_call_recording', 'get_call_transcription',
    -- email
    'search_emails', 'get_email_thread', 'send_email',
    -- calendar
    'get_calendar_events', 'check_availability', 'create_calendar_event', 'update_calendar_event',
    -- docusign
    'get_docusign_envelopes', 'send_docusign_envelope',
    -- esign
    'get_esign_envelopes', 'send_esign_envelope',
    -- client
    'search_clients', 'get_client_detail', 'get_client_pipeline_stats', 'list_stale_clients',
    'add_client_note', 'update_client_phase', 'complete_client_task', 'update_client_field',
    -- awareness
    'get_caregiver_documents', 'get_automation_summary', 'get_inbound_messages', 'get_action_items', 'manage_suggestions'
  ],
  jsonb_build_object(
    -- Reads: auto-execute (matches today's riskLevel: "auto")
    'search_caregivers',         jsonb_build_object('current_level', 'L4'),
    'get_caregiver_detail',      jsonb_build_object('current_level', 'L4'),
    'get_pipeline_stats',        jsonb_build_object('current_level', 'L4'),
    'list_stale_leads',          jsonb_build_object('current_level', 'L4'),
    'check_compliance',          jsonb_build_object('current_level', 'L4'),
    'add_note',                  jsonb_build_object('current_level', 'L4'),
    'add_client_note',           jsonb_build_object('current_level', 'L4'),
    'draft_message',             jsonb_build_object('current_level', 'L4'),
    'get_sms_history',           jsonb_build_object('current_level', 'L4'),
    'get_call_log',              jsonb_build_object('current_level', 'L4'),
    'get_call_recording',        jsonb_build_object('current_level', 'L4'),
    'get_call_transcription',    jsonb_build_object('current_level', 'L4'),
    'search_emails',             jsonb_build_object('current_level', 'L4'),
    'get_email_thread',          jsonb_build_object('current_level', 'L4'),
    'get_calendar_events',       jsonb_build_object('current_level', 'L4'),
    'check_availability',        jsonb_build_object('current_level', 'L4'),
    'get_docusign_envelopes',    jsonb_build_object('current_level', 'L4'),
    'get_esign_envelopes',       jsonb_build_object('current_level', 'L4'),
    'search_clients',            jsonb_build_object('current_level', 'L4'),
    'get_client_detail',         jsonb_build_object('current_level', 'L4'),
    'get_client_pipeline_stats', jsonb_build_object('current_level', 'L4'),
    'list_stale_clients',        jsonb_build_object('current_level', 'L4'),
    'get_caregiver_documents',   jsonb_build_object('current_level', 'L4'),
    'get_automation_summary',    jsonb_build_object('current_level', 'L4'),
    'get_inbound_messages',      jsonb_build_object('current_level', 'L4'),
    'get_action_items',          jsonb_build_object('current_level', 'L4'),
    'manage_suggestions',        jsonb_build_object('current_level', 'L4'),
    -- Writes: confirm-required (matches today's riskLevel: "confirm")
    'send_sms',                  jsonb_build_object('current_level', 'L2'),
    'send_email',                jsonb_build_object('current_level', 'L2'),
    'create_calendar_event',     jsonb_build_object('current_level', 'L2'),
    'update_calendar_event',     jsonb_build_object('current_level', 'L2'),
    'send_docusign_envelope',    jsonb_build_object('current_level', 'L2'),
    'send_esign_envelope',       jsonb_build_object('current_level', 'L2'),
    'update_phase',              jsonb_build_object('current_level', 'L2'),
    'complete_task',             jsonb_build_object('current_level', 'L2'),
    'update_caregiver_field',    jsonb_build_object('current_level', 'L2'),
    'update_board_status',       jsonb_build_object('current_level', 'L2'),
    'update_client_phase',       jsonb_build_object('current_level', 'L2'),
    'complete_client_task',      jsonb_build_object('current_level', 'L2'),
    'update_client_field',       jsonb_build_object('current_level', 'L2')
  ),
  jsonb_build_object(
    'layers', jsonb_build_array('identity', 'situational', 'memories', 'threads', 'viewing', 'guidelines'),
    'pipeline_scope', 'caregivers_and_clients'
  ),
  'claude-sonnet-4-5-20250929',
  5,
  false,
  false,
  jsonb_build_object(
    'note', 'Recruiting outcomes today are inferred from action_outcomes (response_received / completed). Phase 1.1 will tighten this with verified third-party signals (docusign_completed, sms_received, calendar_event_attended).',
    'primary_signals', jsonb_build_array(
      jsonb_build_object('event_type', 'sms_received', 'window_days', 7),
      jsonb_build_object('event_type', 'email_received', 'window_days', 7),
      jsonb_build_object('event_type', 'docusign_completed', 'window_days', 14)
    )
  ),
  jsonb_build_object(
    'invocation_modes', jsonb_build_array('chat', 'briefing', 'confirmed_action'),
    'http_endpoint', '/functions/v1/ai-chat',
    'cron', null
  ),
  'system:phase_0_1_seed',
  'system:phase_0_1_seed'
),

-- ── proactive_planner ─────────────────────────────────────────────────
(
  public.default_org_id(),
  'proactive_planner',
  'Proactive Planner',
  1,
  'You are the daily planner for Tremendous Care, a home care staffing agency in California. Analyze the full pipeline and recommend the highest-impact actions for today. Recommend up to N actions, prioritized by impact. Consider: people who were responsive before but went quiet, people close to completing onboarding, new applicants (24h response window), compliance gaps, and never duplicate actions our automation rules already handle. Draft SMS under 160 chars. Runtime context (pipeline summary, active alert rules, automation rules, recent outcomes, business context) is supplied by the proactive context recipe at invocation time.',
  ARRAY[
    'send_sms', 'send_email', 'add_note', 'add_client_note',
    'complete_task', 'complete_client_task',
    'update_phase', 'update_client_phase',
    'create_calendar_event', 'send_docusign_envelope'
  ],
  jsonb_build_object(
    -- These match the autonomy_config "proactive" context rows
    -- (migration 20260320235959). Notes auto-fire (L4); writes start L1.
    'add_note',                jsonb_build_object('current_level', 'L4'),
    'add_client_note',         jsonb_build_object('current_level', 'L4'),
    'send_sms',                jsonb_build_object('current_level', 'L1'),
    'send_email',              jsonb_build_object('current_level', 'L1'),
    'complete_task',           jsonb_build_object('current_level', 'L1'),
    'complete_client_task',    jsonb_build_object('current_level', 'L1'),
    'update_phase',            jsonb_build_object('current_level', 'L1'),
    'update_client_phase',     jsonb_build_object('current_level', 'L1'),
    'create_calendar_event',   jsonb_build_object('current_level', 'L1'),
    'send_docusign_envelope',  jsonb_build_object('current_level', 'L1')
  ),
  jsonb_build_object(
    'layers', jsonb_build_array('identity', 'situational', 'memories'),
    'pipeline_scope', 'caregivers_and_clients',
    'modes', jsonb_build_array('full_pipeline_daily', 'single_entity_event_triggered')
  ),
  'claude-sonnet-4-5-20250929',
  1,
  false,
  false,
  jsonb_build_object(
    'note', 'Planner suggestions become outcomes when the user approves and the action_outcomes loop closes. See ai_suggestions.status transitions.',
    'primary_signals', jsonb_build_array(
      jsonb_build_object('event_type', 'sms_received', 'window_days', 7),
      jsonb_build_object('event_type', 'email_received', 'window_days', 7),
      jsonb_build_object('event_type', 'docusign_completed', 'window_days', 14)
    )
  ),
  jsonb_build_object(
    'invocation_modes', jsonb_build_array('cron_daily', 'event_triggered'),
    'http_endpoint', '/functions/v1/ai-planner',
    'cron', '0 14 * * *',
    'cron_note', '7am Pacific = 14:00 UTC; idempotency key app_settings.last_planner_run',
    'event_triggers', jsonb_build_array('event_driven_planner_trigger')
  ),
  'system:phase_0_1_seed',
  'system:phase_0_1_seed'
),

-- ── inbound_router ────────────────────────────────────────────────────
(
  public.default_org_id(),
  'inbound_router',
  'Inbound Message Router',
  1,
  'You are a message classifier for Tremendous Care. Given an inbound message from a caregiver or client, classify the intent and suggest the best action. Intents: question, document_submission, scheduling_request, general_response, confirmation, opt_out, unknown. For SMS replies keep drafted_response under 160 chars. If intent is opt_out, do not suggest any action — set action to none. Be warm and professional, use first names, never use [PLACEHOLDER] brackets. Runtime context (entity profile, conversation history, calendar, recent events, business context) is supplied by the inbound context recipe at invocation time.',
  ARRAY[
    -- VALID_ACTIONS from _shared/operations/routing.ts
    'send_sms', 'send_email',
    'add_note', 'add_client_note',
    'update_phase', 'update_client_phase',
    'complete_task', 'complete_client_task',
    'update_caregiver_field', 'update_client_field',
    'update_board_status',
    'create_calendar_event',
    'send_docusign_envelope', 'send_esign_envelope'
  ],
  jsonb_build_object(
    -- These match the autonomy_config "inbound_routing" context rows
    -- (migrations 20260311200407 + 20260320235959).
    'add_note',                 jsonb_build_object('current_level', 'L4'),
    'add_client_note',          jsonb_build_object('current_level', 'L4'),
    'send_sms',                 jsonb_build_object('current_level', 'L2'),
    'send_email',               jsonb_build_object('current_level', 'L2'),
    'update_phase',             jsonb_build_object('current_level', 'L1'),
    'update_client_phase',      jsonb_build_object('current_level', 'L1'),
    'complete_task',            jsonb_build_object('current_level', 'L1'),
    'complete_client_task',     jsonb_build_object('current_level', 'L1'),
    'update_caregiver_field',   jsonb_build_object('current_level', 'L1'),
    'update_client_field',      jsonb_build_object('current_level', 'L1'),
    'update_board_status',      jsonb_build_object('current_level', 'L1'),
    'create_calendar_event',    jsonb_build_object('current_level', 'L1'),
    'send_docusign_envelope',   jsonb_build_object('current_level', 'L1'),
    'send_esign_envelope',      jsonb_build_object('current_level', 'L1')
  ),
  jsonb_build_object(
    'layers', jsonb_build_array('identity', 'memories', 'situational'),
    'pipeline_scope', 'matched_entity_only'
  ),
  -- Inbound classifier today uses Haiku for cost; preserve in seed.
  'claude-haiku-4-5-20251001',
  1,
  false,
  false,
  jsonb_build_object(
    'note', 'Router outcomes are: classification accuracy + reply approval rate. Tracked via ai_suggestions.status transitions.',
    'primary_signals', jsonb_build_array(
      jsonb_build_object('event_type', 'ai_suggestion_approved', 'window_hours', 24),
      jsonb_build_object('event_type', 'sms_received', 'window_days', 7)
    )
  ),
  jsonb_build_object(
    'invocation_modes', jsonb_build_array('cron'),
    'http_endpoint', '/functions/v1/message-router',
    'cron', '*/2 * * * *',
    'cron_note', 'Every 2 minutes; processes message_routing_queue with status=pending'
  ),
  'system:phase_0_1_seed',
  'system:phase_0_1_seed'
)
ON CONFLICT (org_id, slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Seed each agent's first version_history snapshot
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO public.agent_versions (
  org_id, agent_id, agent_slug, version, snapshot, change_summary, changed_by
)
SELECT
  a.org_id,
  a.id,
  a.slug,
  a.version,
  to_jsonb(a) - 'created_at' - 'updated_at',
  'Initial seed (Phase 0.1)',
  'system:phase_0_1_seed'
FROM public.agents a
WHERE a.org_id = public.default_org_id()
  AND a.slug IN ('recruiting', 'proactive_planner', 'inbound_router')
ON CONFLICT (agent_id, version) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Sanity check: assert exactly 3 agents seeded for Tremendous Care, and
--    that their slugs match the expected set.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_count   int;
  v_slugs   text[];
  v_org     uuid := public.default_org_id();
BEGIN
  SELECT count(*), array_agg(slug ORDER BY slug)
    INTO v_count, v_slugs
  FROM public.agents
  WHERE org_id = v_org;

  IF v_count <> 3 THEN
    RAISE EXCEPTION
      'Phase 0.1 sanity check failed: expected 3 seeded agents for Tremendous Care, found %.', v_count;
  END IF;

  IF v_slugs <> ARRAY['inbound_router', 'proactive_planner', 'recruiting'] THEN
    RAISE EXCEPTION
      'Phase 0.1 sanity check failed: expected slugs (inbound_router, proactive_planner, recruiting), found %.', v_slugs;
  END IF;

  -- Each seeded agent must have a version_history row.
  IF (SELECT count(*) FROM public.agent_versions
      WHERE org_id = v_org AND version = 1) <> 3 THEN
    RAISE EXCEPTION
      'Phase 0.1 sanity check failed: expected 3 v1 history rows, found %.',
      (SELECT count(*) FROM public.agent_versions
        WHERE org_id = v_org AND version = 1);
  END IF;
END $$;
