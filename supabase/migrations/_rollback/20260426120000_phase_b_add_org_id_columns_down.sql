-- Rollback for Phase B1 — drop the org_id column from every table B1 added it to.
-- This file lives outside the main migrations folder (underscored directory),
-- so it is NOT auto-applied. Run manually via psql only if Phase B1 must be
-- reverted.
--
-- IMPORTANT: if Phase B2 (the org-scoped RLS policies) has already been
-- deployed, those policies depend on org_id and this rollback will fail
-- with "cannot drop column org_id ... because other objects depend on it".
-- In that case, roll back B2 FIRST, then this script.
--
-- This script does NOT use CASCADE — that would silently drop dependent
-- objects (RLS policies, indexes, FKs from other tables) which is exactly
-- the failure mode that should force you to roll back deeper migrations
-- explicitly first.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260426120000_phase_b_add_org_id_columns_down.sql

BEGIN;

DO $$
DECLARE
  tbl text;
  v_tables text[] := ARRAY[
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
BEGIN
  FOREACH tbl IN ARRAY v_tables LOOP
    EXECUTE format(
      'DROP INDEX IF EXISTS public.%I',
      'idx_' || tbl || '_org_id'
    );
    EXECUTE format(
      'ALTER TABLE public.%I DROP COLUMN IF EXISTS org_id',
      tbl
    );
  END LOOP;
END $$;

-- Drop the helper function last — every column DEFAULT that referenced it
-- has just been removed by the column drops above.
DROP FUNCTION IF EXISTS public.default_org_id();

COMMIT;
