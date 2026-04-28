-- Phase B1 — Tenant isolation: add org_id to every tenant-sensitive table.
--
-- Part of the SaaS retrofit (see docs/SAAS_RETROFIT.md). Phase B1 is purely
-- additive: every table listed below gets a NOT NULL org_id column with a
-- default pointing to Tremendous Care, an index on org_id for the RLS
-- predicates that ship in Phase B2, and a foreign key to organizations(id).
--
-- This migration changes NO behavior. No RLS policy is modified. No query
-- in application code or edge functions is altered. The column is in place
-- and ready for Phase B2 to start enforcing isolation.
--
-- Tables intentionally skipped:
--   organizations, org_memberships  — already tenanted (Phase A).
--   user_roles                      — stays authoritative during transition,
--                                     org_id discussion deferred (per CLAUDE.md
--                                     and SAAS_RETROFIT.md "Role vocabulary").
--   app_settings                    — system-level singleton; per-org config
--                                     migrates to organizations.settings in Phase D.
--   intake_queue                    — universal landing zone, intentionally
--                                     org-agnostic until normalized into
--                                     caregivers/clients downstream.
--   timesheets, timesheet_shifts,
--   payroll_runs, paychex_api_log   — born tenanted in the recent Paychex
--                                     migrations (20260425170001-20260425170004).
--                                     Already have org_id, RLS, and index.
--
-- Default value strategy (locked in docs/SAAS_RETROFIT.md → Decisions locked,
-- 2026-04-26, revised the same day after PR review): a STABLE helper function
-- public.default_org_id(), not a hardcoded UUID literal and not a raw
-- subquery. PostgreSQL forbids subqueries inside column DEFAULT clauses
-- (CREATE TABLE / ALTER TABLE … SET DEFAULT require a variable-free
-- expression), so the original "subselect default" plan was infeasible. A
-- STABLE function call is allowed in DEFAULT clauses, runs against a 1-row
-- table with a unique index on slug, and remains resilient to any future
-- Tremendous Care identity reissue. The function and the per-table defaults
-- are both dropped in Phase E once explicit org_id becomes mandatory on
-- every insert path.
--
-- Index note: CREATE INDEX (not CONCURRENTLY) is used because Supabase
-- migrations run in a single transaction. Tremendous Care's current scale
-- makes the brief AccessExclusiveLock per table negligible. Revisit at
-- multi-customer scale.

-- Helper function used as the column DEFAULT for every tenant-sensitive
-- table. STABLE so PG can cache the result within a single statement.
-- Returns NULL only if the Tremendous Care row has been deleted, which the
-- per-table NOT NULL constraint will then catch — desired fail-loud
-- behavior. Dropped in Phase E.
CREATE OR REPLACE FUNCTION public.default_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT id FROM public.organizations WHERE slug = 'tremendous-care'
$$;

DO $$
DECLARE
  tbl       text;
  v_tc_id   uuid;
  -- 42 tenant-sensitive tables, grouped by domain for review sanity.
  -- Order within the array does not affect correctness.
  v_tables  text[] := ARRAY[
    -- Recruiting / clients (8)
    'caregivers',
    'clients',
    'caregiver_assignments',
    'caregiver_documents',
    'document_upload_tokens',
    'team_members',
    'boards',
    'board_cards',

    -- Scheduling (4) — timesheets/timesheet_shifts already tenanted
    'shifts',
    'shift_offers',
    'caregiver_availability',
    'clock_events',

    -- Care plans & clinical (5)
    'care_plans',
    'care_plan_versions',
    'care_plan_tasks',
    'care_plan_observations',
    'care_plan_digests',

    -- AI / context layer (5)
    'events',
    'context_memory',
    'context_snapshots',
    'action_outcomes',
    'ai_suggestions',

    -- Automation / workflow (6)
    'automation_rules',
    'automation_log',
    'action_item_rules',
    'client_sequences',
    'client_sequence_enrollments',
    'client_sequence_log',

    -- Communication (10)
    'inbound_sms_log',
    'call_transcriptions',
    'message_templates',
    'message_routing_queue',
    'email_accounts',
    'email_routing',
    'docusign_envelopes',
    'esign_envelopes',
    'esign_templates',
    'communication_routes',

    -- Surveys & ops (4)
    'survey_templates',
    'survey_responses',
    'system_metrics',
    'autonomy_config'
  ];
BEGIN
  -- Defensive: Phase A's seed must be in place. If the Tremendous Care org
  -- row is missing, abort loudly rather than silently backfilling NULL.
  SELECT id INTO v_tc_id
  FROM public.organizations
  WHERE slug = 'tremendous-care';

  IF v_tc_id IS NULL THEN
    RAISE EXCEPTION
      'Phase B1 aborted: organizations row with slug=tremendous-care is missing. Phase A must be deployed first.';
  END IF;

  FOREACH tbl IN ARRAY v_tables LOOP
    -- 1. Add column (nullable for now). Idempotent.
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id)',
      tbl
    );

    -- 2. Backfill any NULL rows to Tremendous Care's id. Idempotent — a
    --    re-run only touches rows that somehow ended up NULL.
    EXECUTE format(
      'UPDATE public.%I SET org_id = $1 WHERE org_id IS NULL',
      tbl
    ) USING v_tc_id;

    -- 3. Tighten: NOT NULL plus a default for any future insert that omits
    --    org_id. Default is the same subselect, so identity is resolved at
    --    insert time — survives any future Tremendous Care id reissue.
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN org_id SET NOT NULL',
      tbl
    );
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN org_id SET DEFAULT public.default_org_id()',
      tbl
    );

    -- 4. Index on org_id. Required for the RLS predicates that ship in B2
    --    to be fast.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (org_id)',
      'idx_' || tbl || '_org_id', tbl
    );
  END LOOP;
END $$;

-- Sanity checks. These RAISE EXCEPTION on failure, aborting the migration
-- transaction, so partial state is impossible.
DO $$
DECLARE
  v_missing text;
  v_tables  text[] := ARRAY[
    'caregivers', 'clients', 'caregiver_assignments', 'caregiver_documents',
    'document_upload_tokens', 'team_members', 'boards', 'board_cards',
    'shifts', 'shift_offers', 'caregiver_availability', 'clock_events',
    'care_plans', 'care_plan_versions', 'care_plan_tasks', 'care_plan_observations',
    'care_plan_digests', 'events', 'context_memory', 'context_snapshots',
    'action_outcomes', 'ai_suggestions', 'automation_rules', 'automation_log',
    'action_item_rules', 'client_sequences', 'client_sequence_enrollments',
    'client_sequence_log', 'inbound_sms_log', 'call_transcriptions',
    'message_templates', 'message_routing_queue', 'email_accounts', 'email_routing',
    'docusign_envelopes', 'esign_envelopes', 'esign_templates', 'communication_routes',
    'survey_templates', 'survey_responses', 'system_metrics', 'autonomy_config'
  ];
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY v_tables LOOP
    -- Verify org_id exists, is NOT NULL, and has a value on every row.
    EXECUTE format(
      'SELECT %L FROM public.%I WHERE org_id IS NULL LIMIT 1',
      tbl, tbl
    ) INTO v_missing;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'Phase B1 sanity check failed: % has rows with NULL org_id after backfill.', tbl;
    END IF;
  END LOOP;
END $$;
