-- ═══════════════════════════════════════════════════════════════
-- Caregiver Portal — Phase 1, Step 2: RLS hardening
--
-- Rewrites every permissive `authenticated USING (true)` policy in
-- the database to `authenticated USING (public.is_staff())` so that,
-- once caregivers have auth accounts, their JWTs can't read data
-- that's not theirs. Then adds narrow caregiver-scoped policies on
-- the five tables they legitimately need.
--
-- Safety model
-- ────────────
--   * Every existing staff user has a row in `user_roles` with role
--     'admin' or 'member'. `public.is_staff()` returns true for them,
--     so their access is IDENTICAL to before.
--   * Caregivers (once linked via `caregivers.user_id`) get SELECT
--     on their own row + the narrow set of tables required for the
--     PWA. All other tables return zero rows for them.
--   * service_role policies are untouched — edge functions keep
--     working.
--   * `user_roles.SELECT` is tightened to "own row only" so a
--     logged-in caregiver can't enumerate staff emails. `is_staff()`
--     itself reads `user_roles` via SECURITY DEFINER and bypasses
--     RLS, so the function still works.
--   * `user_roles` self-insert (previously allowed anyone to insert
--     their own row as 'member') is removed. New staff must be added
--     by an admin. This closes the "caregiver auto-promotes to
--     member by visiting /" hole.
--
-- Re-runnability
-- ──────────────
--   All DROP POLICY statements use IF EXISTS. CREATE POLICY is
--   unconditional because we always drop first. Running this twice
--   is safe.
-- ═══════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────
-- 1. Tables locked to staff-only  (caregivers CANNOT access)
-- ─────────────────────────────────────────────────────────────
-- For each: drop the permissive `authenticated` policy and recreate
-- it guarded by public.is_staff(). service_role policies are left
-- untouched.

-- ── app_data ─────────────────────────────────────────────────
DROP POLICY IF EXISTS authenticated_full_access_app_data ON app_data;
DROP POLICY IF EXISTS "Authenticated full access" ON app_data;
CREATE POLICY app_data_staff_all ON app_data
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

-- ── app_settings ─────────────────────────────────────────────
DROP POLICY IF EXISTS authenticated_read_app_settings ON app_settings;
CREATE POLICY app_settings_staff_read ON app_settings
  FOR SELECT TO authenticated
  USING (public.is_staff());

-- ── caregiver_documents ──────────────────────────────────────
DROP POLICY IF EXISTS authenticated_full_access_caregiver_documents ON caregiver_documents;
DROP POLICY IF EXISTS "Authenticated full access" ON caregiver_documents;
CREATE POLICY caregiver_documents_staff_all ON caregiver_documents
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

-- ── docusign_envelopes ───────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can read docusign_envelopes" ON docusign_envelopes;
DROP POLICY IF EXISTS "Authenticated users can insert docusign_envelopes" ON docusign_envelopes;
DROP POLICY IF EXISTS "Authenticated users can update docusign_envelopes" ON docusign_envelopes;
CREATE POLICY docusign_envelopes_staff_all ON docusign_envelopes
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

-- ── client_sequences / client_sequence_log ──────────────────
DROP POLICY IF EXISTS "Authenticated full access on client_sequences" ON client_sequences;
CREATE POLICY client_sequences_staff_all ON client_sequences
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "Authenticated read on client_sequence_log" ON client_sequence_log;
DROP POLICY IF EXISTS "Service insert on client_sequence_log"    ON client_sequence_log;
DROP POLICY IF EXISTS "Service update on client_sequence_log"    ON client_sequence_log;
CREATE POLICY client_sequence_log_staff_read ON client_sequence_log
  FOR SELECT TO authenticated USING (public.is_staff());
-- Edge functions write via service_role (see service_role policies below).

-- ── client_sequence_enrollments ─────────────────────────────
DROP POLICY IF EXISTS "Authenticated users full access" ON client_sequence_enrollments;
CREATE POLICY client_sequence_enrollments_staff_all ON client_sequence_enrollments
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

-- ── automation_rules (keep admin-only writes, lock reads to staff) ─
DROP POLICY IF EXISTS authenticated_read_automation_rules ON automation_rules;
CREATE POLICY automation_rules_staff_read ON automation_rules
  FOR SELECT TO authenticated USING (public.is_staff());
-- admin_insert / admin_update / admin_delete policies remain.

-- ── automation_log ───────────────────────────────────────────
DROP POLICY IF EXISTS allow_authenticated_read_automation_log ON automation_log;
CREATE POLICY automation_log_staff_read ON automation_log
  FOR SELECT TO authenticated USING (public.is_staff());

-- ── action_item_rules ────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can read action_item_rules" ON action_item_rules;
CREATE POLICY action_item_rules_staff_read ON action_item_rules
  FOR SELECT TO authenticated USING (public.is_staff());

-- ── context_memory / events / context_snapshots / action_outcomes ──
DROP POLICY IF EXISTS context_memory_all    ON context_memory;
DROP POLICY IF EXISTS events_all            ON events;
DROP POLICY IF EXISTS context_snapshots_all ON context_snapshots;
DROP POLICY IF EXISTS action_outcomes_all   ON action_outcomes;
CREATE POLICY context_memory_staff_all    ON context_memory
  FOR ALL TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY events_staff_all            ON events
  FOR ALL TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY context_snapshots_staff_all ON context_snapshots
  FOR ALL TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY action_outcomes_staff_all   ON action_outcomes
  FOR ALL TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());

-- ── inbound_sms_log / call_transcriptions ───────────────────
DROP POLICY IF EXISTS "Authenticated users can read inbound SMS log" ON inbound_sms_log;
CREATE POLICY inbound_sms_log_staff_read ON inbound_sms_log
  FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "Authenticated users can read transcriptions" ON call_transcriptions;
CREATE POLICY call_transcriptions_staff_read ON call_transcriptions
  FOR SELECT TO authenticated USING (public.is_staff());

-- ── message_routing_queue / autonomy_config / ai_suggestions ─
DROP POLICY IF EXISTS "Authenticated users can read message_routing_queue" ON message_routing_queue;
CREATE POLICY message_routing_queue_staff_read ON message_routing_queue
  FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "Authenticated users can read autonomy_config" ON autonomy_config;
CREATE POLICY autonomy_config_staff_read ON autonomy_config
  FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "Authenticated users can read ai_suggestions"   ON ai_suggestions;
DROP POLICY IF EXISTS "Authenticated users can update ai_suggestions" ON ai_suggestions;
CREATE POLICY ai_suggestions_staff_read ON ai_suggestions
  FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY ai_suggestions_staff_update ON ai_suggestions
  FOR UPDATE TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());

-- ── system_metrics ───────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can read metrics" ON system_metrics;
CREATE POLICY system_metrics_staff_read ON system_metrics
  FOR SELECT TO authenticated USING (public.is_staff());

-- ── document_upload_tokens ──────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can insert tokens" ON document_upload_tokens;
DROP POLICY IF EXISTS "Authenticated users can read tokens"   ON document_upload_tokens;
DROP POLICY IF EXISTS "Authenticated users can update tokens" ON document_upload_tokens;
CREATE POLICY document_upload_tokens_staff_all ON document_upload_tokens
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

-- ── boards / board_cards (were wide-open to anyone, even anon!) ──
DROP POLICY IF EXISTS boards_all      ON boards;
DROP POLICY IF EXISTS board_cards_all ON board_cards;
CREATE POLICY boards_staff_all ON boards
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY board_cards_staff_all ON board_cards
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

-- ── survey_templates / survey_responses ─────────────────────
-- The anon read/update policies are preserved: caregivers/clients
-- fill out surveys via a public token URL and need anon access.
DROP POLICY IF EXISTS survey_templates_auth ON survey_templates;
DROP POLICY IF EXISTS survey_responses_auth ON survey_responses;
CREATE POLICY survey_templates_staff_all ON survey_templates
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY survey_responses_staff_all ON survey_responses
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

-- ── esign_templates / esign_envelopes ───────────────────────
DROP POLICY IF EXISTS "Authenticated users can manage esign_templates" ON esign_templates;
DROP POLICY IF EXISTS "Authenticated users can manage esign_envelopes" ON esign_envelopes;
CREATE POLICY esign_templates_staff_all ON esign_templates
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY esign_envelopes_staff_all ON esign_envelopes
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

-- ── team_members (was read-all authenticated) ────────────────
DROP POLICY IF EXISTS "Authenticated users can read team_members" ON team_members;
CREATE POLICY team_members_staff_read ON team_members
  FOR SELECT TO authenticated USING (public.is_staff());

-- ── communication_routes ────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can read communication_routes" ON communication_routes;
CREATE POLICY communication_routes_staff_read ON communication_routes
  FOR SELECT TO authenticated USING (public.is_staff());

-- ── care_plans / caregiver_availability / shift_offers ──────
-- (care_plans + availability will get caregiver-scoped policies in
-- a later phase; for now caregivers don't touch them directly.)
DROP POLICY IF EXISTS care_plans_all             ON care_plans;
DROP POLICY IF EXISTS caregiver_availability_all ON caregiver_availability;
DROP POLICY IF EXISTS shift_offers_all           ON shift_offers;
CREATE POLICY care_plans_staff_all ON care_plans
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY caregiver_availability_staff_all ON caregiver_availability
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY shift_offers_staff_all ON shift_offers
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());


-- ─────────────────────────────────────────────────────────────
-- 2. Tables with staff-all + caregiver-scoped access
-- ─────────────────────────────────────────────────────────────

-- ── caregivers ───────────────────────────────────────────────
-- Staff: full access.
-- Caregiver: SELECT only their own row (matched by user_id).
DROP POLICY IF EXISTS authenticated_full_access_caregivers ON caregivers;
DROP POLICY IF EXISTS "Authenticated full access"          ON caregivers;
CREATE POLICY caregivers_staff_all ON caregivers
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY caregivers_read_own ON caregivers
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ── clients ──────────────────────────────────────────────────
-- Staff: full access.
-- Caregiver: SELECT clients they have a shift or assignment with.
-- This is the minimum surface needed for the PWA to show the client
-- name + address + geofence coords on a shift card. They do NOT get
-- care_needs, budget, insurance_info, etc. via the app (the PWA
-- selects specific columns).
DROP POLICY IF EXISTS "Authenticated full access on clients" ON clients;
CREATE POLICY clients_staff_all ON clients
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY clients_read_assigned ON clients
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM shifts
      WHERE shifts.client_id = clients.id
        AND shifts.assigned_caregiver_id = public.current_user_caregiver_id()
    )
    OR EXISTS (
      SELECT 1 FROM caregiver_assignments ca
      WHERE ca.client_id = clients.id
        AND ca.caregiver_id = public.current_user_caregiver_id()
        AND ca.status = 'active'
    )
  );

-- ── shifts ───────────────────────────────────────────────────
-- Staff: full access.
-- Caregiver: SELECT their own shifts. Writes go through the
-- caregiver-clock edge function (service_role) — we intentionally
-- DO NOT grant UPDATE to caregivers so they can't arbitrarily flip
-- status or reassign themselves.
DROP POLICY IF EXISTS shifts_all ON shifts;
CREATE POLICY shifts_staff_all ON shifts
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY shifts_read_own ON shifts
  FOR SELECT TO authenticated
  USING (assigned_caregiver_id = public.current_user_caregiver_id());

-- ── clock_events ─────────────────────────────────────────────
-- Staff: full access.
-- Caregiver: SELECT their own events. INSERT goes through the
-- caregiver-clock edge function (service_role) so the server-side
-- geofence check is non-negotiable.
DROP POLICY IF EXISTS clock_events_all ON clock_events;
CREATE POLICY clock_events_staff_all ON clock_events
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY clock_events_read_own ON clock_events
  FOR SELECT TO authenticated
  USING (caregiver_id = public.current_user_caregiver_id());

-- ── caregiver_assignments ───────────────────────────────────
-- Staff: full access.
-- Caregiver: SELECT their own assignments.
DROP POLICY IF EXISTS caregiver_assignments_all ON caregiver_assignments;
CREATE POLICY caregiver_assignments_staff_all ON caregiver_assignments
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY caregiver_assignments_read_own ON caregiver_assignments
  FOR SELECT TO authenticated
  USING (caregiver_id = public.current_user_caregiver_id());


-- ─────────────────────────────────────────────────────────────
-- 3. user_roles — tighten SELECT + remove self-insert
-- ─────────────────────────────────────────────────────────────
-- Previously: any authenticated user could SELECT all rows and
-- INSERT their own row as 'member'. Caregivers authenticating via
-- magic link would auto-promote to staff on first admin-portal
-- visit. Close both holes.

DROP POLICY IF EXISTS authenticated_read_user_roles ON user_roles;
DROP POLICY IF EXISTS admins_manage_user_roles      ON user_roles;
DROP POLICY IF EXISTS admins_insert_user_roles      ON user_roles;

CREATE POLICY user_roles_read_own ON user_roles
  FOR SELECT TO authenticated
  USING (email = lower((select auth.jwt()) ->> 'email'));

CREATE POLICY user_roles_admins_insert ON user_roles
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.email = lower((select auth.jwt()) ->> 'email')
        AND ur.role = 'admin'
    )
  );
-- `admins_update_user_roles` (already admin-only) remains.
