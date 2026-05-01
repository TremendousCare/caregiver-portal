-- Agent Platform — Phase 0.2: agent_id columns + backfill on AI-tier tables.
--
-- Part of the Agent Platform (see docs/AGENT_PLATFORM.md → Phase 0.2).
-- Pure additive: four nullable columns, four supporting indexes, deterministic
-- backfill of historical rows that are confidently attributable, and three
-- sanity DO blocks that abort the deploy if backfill drift is detected.
--
-- Why nullable in 0.2 (and not yet NOT NULL):
--   * Some events are not agent-caused (direct user actions on the portal,
--     caregiver self-service uploads, system jobs like geocode and payroll).
--     `agent_id IS NULL` on those rows is the correct semantics.
--   * Some context_memory rows are intentionally org-level shared (Prime
--     Directive #4: agent_id IS NULL means "shareable across all agents in
--     the org"). NULL is a meaningful value here.
--   * Phase 0.4 audits every insert path on ai_suggestions and action_outcomes
--     to set agent_id explicitly. Once that ships, Phase 1.x considers
--     tightening those two tables to NOT NULL.
--
-- Backfill heuristics (deterministic — no LLM, no fuzzy matching):
--   ai_suggestions:
--     source_type='inbound_sms'    -> inbound_router
--     source_type='inbound_email'  -> inbound_router
--     source_type='proactive'      -> proactive_planner
--     source_type='event_triggered'-> proactive_planner
--     source_type='outcome'        -> proactive_planner (consolidation feedback)
--   action_outcomes:
--     source='ai_chat'             -> recruiting
--     source='automation'          -> NULL (rule engine is not an agent)
--     source='manual'              -> NULL (operator-driven, not agent-caused)
--   events:
--     actor LIKE 'system:ai-planner%'    -> proactive_planner
--     actor LIKE 'system:message-router%'-> inbound_router
--     actor LIKE 'system:ai-chat%'       -> recruiting
--     all others                         -> NULL (not agent-attributable)
--   context_memory:
--     no rows in production today; column added unstamped. Future writes
--     stamp from the runtime in Phase 0.4.
--
-- Production data snapshot (2026-04-30, used to size the sanity checks):
--   ai_suggestions: 3,847 rows total, 100% attributable
--   action_outcomes: 11 rows total, 100% attributable
--   events: ~330 rows total, 0 currently attributable (no system:ai-* actors)
--   context_memory: 0 rows
--
-- Idempotency: every column add and index uses IF NOT EXISTS. Backfill
-- UPDATEs are idempotent (re-running stamps the same rows the same way).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Add nullable agent_id columns to the four AI-tier tables
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.agents(id);

ALTER TABLE public.action_outcomes
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.agents(id);

ALTER TABLE public.ai_suggestions
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.agents(id);

ALTER TABLE public.context_memory
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.agents(id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Indexes — one composite per table for the typical "agent X in org Y
--    over time" query pattern. created_at DESC because newest-first is the
--    dominant access pattern across all four tables.
-- ─────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_events_org_agent_time
  ON public.events (org_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_action_outcomes_org_agent_time
  ON public.action_outcomes (org_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_suggestions_org_agent_time
  ON public.ai_suggestions (org_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_memory_org_agent_time
  ON public.context_memory (org_id, agent_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Backfill — deterministic, per-table.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Resolve agent ids inside a DO block so we read them once per table-update
-- instead of joining on every row. agents are seeded for Tremendous Care in
-- Phase 0.1; org_id stays scoped to default_org_id() per the SaaS retrofit.

DO $$
DECLARE
  v_org              uuid := public.default_org_id();
  v_recruiting_id    uuid;
  v_planner_id       uuid;
  v_router_id        uuid;
BEGIN
  SELECT id INTO v_recruiting_id FROM public.agents
    WHERE org_id = v_org AND slug = 'recruiting';
  SELECT id INTO v_planner_id    FROM public.agents
    WHERE org_id = v_org AND slug = 'proactive_planner';
  SELECT id INTO v_router_id     FROM public.agents
    WHERE org_id = v_org AND slug = 'inbound_router';

  IF v_recruiting_id IS NULL OR v_planner_id IS NULL OR v_router_id IS NULL THEN
    RAISE EXCEPTION
      'Phase 0.2 backfill aborted: missing seeded agents. recruiting=%, planner=%, router=%',
      v_recruiting_id, v_planner_id, v_router_id;
  END IF;

  -- ai_suggestions: stamp by source_type
  UPDATE public.ai_suggestions
     SET agent_id = v_router_id
   WHERE org_id = v_org
     AND agent_id IS NULL
     AND source_type IN ('inbound_sms', 'inbound_email');

  UPDATE public.ai_suggestions
     SET agent_id = v_planner_id
   WHERE org_id = v_org
     AND agent_id IS NULL
     AND source_type IN ('proactive', 'event_triggered', 'outcome');

  -- action_outcomes: stamp by source. Only ai_chat → recruiting today.
  -- 'automation' and 'manual' rows stay NULL (not agent-caused).
  UPDATE public.action_outcomes
     SET agent_id = v_recruiting_id
   WHERE org_id = v_org
     AND agent_id IS NULL
     AND source = 'ai_chat';

  -- events: stamp by actor pattern. Narrow patterns only — anything else
  -- is direct user action, caregiver self-service, or non-agent system
  -- jobs (caregiver-invite, geocode, payroll-generate-timesheets).
  UPDATE public.events
     SET agent_id = v_planner_id
   WHERE org_id = v_org
     AND agent_id IS NULL
     AND actor LIKE 'system:ai-planner%';

  UPDATE public.events
     SET agent_id = v_router_id
   WHERE org_id = v_org
     AND agent_id IS NULL
     AND actor LIKE 'system:message-router%';

  UPDATE public.events
     SET agent_id = v_recruiting_id
   WHERE org_id = v_org
     AND agent_id IS NULL
     AND actor LIKE 'system:ai-chat%';

  -- context_memory: zero rows today. No backfill UPDATE needed.
  -- Future writes stamp agent_id from the runtime in Phase 0.4.
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Sanity checks — assert backfill produced the expected coverage.
-- ─────────────────────────────────────────────────────────────────────────
--
-- These guards abort the transaction (and therefore the migration deploy)
-- if backfill produced unexpected drift. The migration is idempotent so a
-- corrected re-run picks up where the failed one stopped.

DO $$
DECLARE
  v_org                    uuid := public.default_org_id();
  v_unstamped_suggestions  bigint;
  v_unstamped_outcomes     bigint;
  v_stamped_events         bigint;
  v_unattributable_events  bigint;
BEGIN
  -- ai_suggestions: every row with a known source_type must be stamped.
  SELECT count(*) INTO v_unstamped_suggestions
  FROM public.ai_suggestions
  WHERE org_id = v_org
    AND agent_id IS NULL
    AND source_type IN ('inbound_sms', 'inbound_email', 'proactive', 'event_triggered', 'outcome');

  IF v_unstamped_suggestions <> 0 THEN
    RAISE EXCEPTION
      'Phase 0.2 sanity check failed: % ai_suggestions rows have known source_type but no agent_id stamped.',
      v_unstamped_suggestions;
  END IF;

  -- action_outcomes: every ai_chat row must be stamped to recruiting.
  SELECT count(*) INTO v_unstamped_outcomes
  FROM public.action_outcomes
  WHERE org_id = v_org
    AND agent_id IS NULL
    AND source = 'ai_chat';

  IF v_unstamped_outcomes <> 0 THEN
    RAISE EXCEPTION
      'Phase 0.2 sanity check failed: % action_outcomes rows with source=ai_chat have no agent_id stamped.',
      v_unstamped_outcomes;
  END IF;

  -- events: report (don't fail) how many ended up agent-attributable vs
  -- non-attributable. This is informational; in production today, zero
  -- events have system:ai-* actors so v_stamped_events will be 0. The
  -- log line is the trail for future diagnostics.
  SELECT count(*) INTO v_stamped_events
  FROM public.events
  WHERE org_id = v_org AND agent_id IS NOT NULL;

  SELECT count(*) INTO v_unattributable_events
  FROM public.events
  WHERE org_id = v_org AND agent_id IS NULL;

  RAISE NOTICE
    'Phase 0.2 events backfill: % stamped, % unattributable (left NULL).',
    v_stamped_events, v_unattributable_events;
END $$;
