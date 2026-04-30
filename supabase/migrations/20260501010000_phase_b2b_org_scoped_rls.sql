-- Phase B2b — org-scoped RLS policies on every B1 table.
--
-- Part of the SaaS retrofit (see docs/SAAS_RETROFIT.md → Phase B). B2b is
-- additive: every targeted table gets a NEW permissive policy that filters
-- on the org_id JWT claim, ALONGSIDE the existing permissive policies. In
-- PostgreSQL, multiple permissive policies OR together — so a row is
-- visible to a user if any one policy grants access. This means:
--
--   * Tremendous Care users continue to work unchanged. Their JWT carries
--     org_id = <tremendous_care_uuid> (Phase A) and every existing row's
--     org_id matches it (Phase B1), so the new policies grant access in
--     parallel with the existing is_staff() / current_user_caregiver_id()
--     policies.
--   * No user is locked out by this migration. The strict enforcement
--     happens in Phase B5 when the existing permissive policies drop.
--
-- Skipped tables (2 of 42):
--   email_accounts, email_routing — these have RLS enabled but ZERO
--   policies today (service-role-only). Adding a permissive policy here
--   would *open* access. Left untouched; they remain service-role-only.
--
-- Predicate (locked decision in docs/SAAS_RETROFIT_STATUS.md, 2026-04-26):
--   strict / fail-closed. A missing or unparseable org_id claim denies.
--   We use nullif(..., '') to coerce an empty-string claim to NULL, which
--   then fails the equality check (NULL = anything is NULL, treated as
--   false in RLS). The cast to uuid raises if the claim is non-empty but
--   malformed — also a deny, also fail-closed. Service-role queries
--   bypass RLS entirely and are unaffected.
--
-- Policy naming: tenant_isolation_<table>_<select|insert|update|delete>
-- One policy per command rather than a single FOR ALL. This is uniform,
-- grep-friendly, and lets B5 drop them all with a single DO loop later.
--
-- Idempotent: each CREATE POLICY is preceded by DROP POLICY IF EXISTS, so
-- re-running the migration is safe (e.g., from the deploy workflow).

DO $$
DECLARE
  tbl  text;
  -- 40 tables. Same set as B1 minus email_accounts and email_routing.
  v_tables text[] := ARRAY[
    -- Recruiting / clients (8)
    'caregivers',
    'clients',
    'caregiver_assignments',
    'caregiver_documents',
    'document_upload_tokens',
    'team_members',
    'boards',
    'board_cards',

    -- Scheduling (4)
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

    -- Communication (8) — email_accounts, email_routing skipped
    'inbound_sms_log',
    'call_transcriptions',
    'message_templates',
    'message_routing_queue',
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
  v_predicate constant text :=
    'org_id = nullif(auth.jwt() ->> ''org_id'', '''')::uuid';
BEGIN
  FOREACH tbl IN ARRAY v_tables LOOP
    -- SELECT
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_isolation_' || tbl || '_select', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
      'tenant_isolation_' || tbl || '_select', tbl, v_predicate
    );

    -- INSERT
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_isolation_' || tbl || '_insert', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)',
      'tenant_isolation_' || tbl || '_insert', tbl, v_predicate
    );

    -- UPDATE
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_isolation_' || tbl || '_update', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
      'tenant_isolation_' || tbl || '_update', tbl, v_predicate, v_predicate
    );

    -- DELETE
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_isolation_' || tbl || '_delete', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (%s)',
      'tenant_isolation_' || tbl || '_delete', tbl, v_predicate
    );
  END LOOP;
END $$;

-- Sanity check: assert the expected number of tenant_isolation_* policies
-- exists. 40 tables * 4 commands = 160. Aborts the deploy on any drift.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*)
    INTO v_count
  FROM pg_policy
  WHERE polname LIKE 'tenant_isolation\_%' ESCAPE '\';

  IF v_count <> 160 THEN
    RAISE EXCEPTION
      'Phase B2b sanity check failed: expected 160 tenant_isolation_* policies, found %.', v_count;
  END IF;
END $$;
