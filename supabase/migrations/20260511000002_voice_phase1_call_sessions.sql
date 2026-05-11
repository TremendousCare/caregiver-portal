-- Voice / CTI Phase 1 — call_sessions table.
--
-- One row per call. The Telephony Sessions webhook handler upserts
-- this row as the call progresses through ringing -> answered ->
-- ended (or ringing -> missed / voicemail). PR 3 reads it for the
-- screen-pop, recent-calls dashboard widget, and active-call bar.
-- PR 4+ extends with AI summary, outcome correlation, and tasking.
--
-- WHY A DEDICATED TABLE (NOT JUST events):
--   events is append-only and shape-agnostic. call_sessions is one
--   stateful row whose status transitions during the call's life,
--   plus a recording/transcript that arrives ~30s after the call
--   ends. The two work together: every state transition also writes
--   an event row (call_ringing, call_answered, call_ended,
--   call_missed, call_outbound_initiated) so the audit log is
--   never out of sync with the session.
--
-- PHONE -> ENTITY MATCH:
--   The webhook handler reuses the existing SMS phone-match
--   function (supabase/functions/_shared/ helpers) so SMS and voice
--   never disagree on who is calling. Populated columns:
--     matched_entity_type ('caregiver' | 'client')
--     matched_entity_id
--   Both NULL when no match (unknown caller); the UI surfaces a
--   "create record?" prompt instead of a profile pop.
--
-- EXTENSION -> USER MATCH:
--   For inbound, the webhook handler looks up extension_id in the
--   new uniq_org_memberships_rc_extension_per_org index from
--   migration 20260511000001 to determine which user's browser
--   gets the realtime screen-pop broadcast.
--
-- TENANT ISOLATION:
--   org_id NOT NULL DEFAULT public.default_org_id() per Phase B
--   locked decision. Four tenant_isolation_<table>_<command>
--   policies per the B2b convention (PR #237) plus
--   service_role_full_access_call_sessions for the webhook handler
--   and post-call transcription cron.
--
-- ROLLBACK: supabase/migrations/_rollback/20260511000002_*_down.sql

CREATE TABLE IF NOT EXISTS call_sessions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL DEFAULT public.default_org_id()
                              REFERENCES organizations(id) ON DELETE RESTRICT,

  -- RC identifiers ---------------------------------------------------
  -- Telephony Sessions exposes a session id (per-call) and party ids
  -- (per leg). For a basic 1:1 inbound or outbound, we track the
  -- session + the caller-side party id. Conference / transfer scenarios
  -- create additional parties; out of scope for Phase 1.
  telephony_session_id     text NOT NULL,
  party_id                 text,

  -- Direction & status ----------------------------------------------
  direction                text NOT NULL
                              CHECK (direction IN ('inbound', 'outbound')),
  -- Status transitions for an inbound call:
  --   ringing -> answered -> ended         (normal)
  --   ringing -> missed                    (no pickup, no voicemail)
  --   ringing -> voicemail                 (rolled to voicemail)
  -- For outbound:
  --   ringing -> answered -> ended         (callee picked up)
  --   ringing -> ended                     (callee didn't pick up)
  status                   text NOT NULL
                              CHECK (status IN (
                                'ringing', 'answered', 'ended',
                                'missed', 'voicemail'
                              )),

  -- Identity ---------------------------------------------------------
  from_e164                text,
  to_e164                  text,
  -- The RC extension involved in the call (for inbound: the extension
  -- that rang; for outbound: the extension that placed the call).
  -- Joins to org_memberships.ringcentral_extension_id.
  extension_id             text,
  -- Resolved at webhook time. NULL on unknown caller / no membership.
  matched_user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  matched_entity_type      text CHECK (matched_entity_type IN ('caregiver', 'client')),
  -- Text because caregivers.id and clients.id are text in this schema.
  -- We don't FK because the column points to either table.
  matched_entity_id        text,

  -- Timing -----------------------------------------------------------
  started_at               timestamptz,
  answered_at              timestamptz,
  ended_at                 timestamptz,
  duration_seconds         integer,

  -- Recording & transcription ---------------------------------------
  -- Populated by the post-call worker after the call ends. recording_id
  -- is RC's id; recording_url is the proxied URL through our
  -- call-recording edge function (already exists in the codebase).
  -- The transcript itself lives in call_transcriptions, joined by
  -- recording_id (that table's PK). transcript_fetched_at is the
  -- worker's idempotent "done" marker — set when the transcript row
  -- has been written (or attempted N times without success). Keeps
  -- the pending-transcript partial index narrow without a subquery.
  recording_id             text,
  recording_url            text,
  transcript_fetched_at    timestamptz,

  -- AI processing (future) -------------------------------------------
  -- Filled by Phase 3 post-call AI pipeline. NULL in Phase 1.
  ai_summary               text,
  ai_outcome               jsonb,

  -- Debugging --------------------------------------------------------
  -- Raw RC webhook payload for the most recent state transition. Lets
  -- us debug "the call_sessions row is wrong" without re-subscribing.
  raw_event_payload        jsonb,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- One row per (org, RC session). The webhook handler upserts on
  -- this key as the call progresses.
  CONSTRAINT call_sessions_unique_session
    UNIQUE (org_id, telephony_session_id)
);

-- Recent-calls dashboard widget; matched_user filter is "my calls".
CREATE INDEX IF NOT EXISTS idx_call_sessions_org_started
  ON call_sessions (org_id, started_at DESC);

-- Entity profile call history.
CREATE INDEX IF NOT EXISTS idx_call_sessions_matched_entity
  ON call_sessions (matched_entity_type, matched_entity_id, started_at DESC)
  WHERE matched_entity_id IS NOT NULL;

-- "My calls" filter on the dashboard.
CREATE INDEX IF NOT EXISTS idx_call_sessions_matched_user
  ON call_sessions (matched_user_id, started_at DESC)
  WHERE matched_user_id IS NOT NULL;

-- Post-call worker scans for ended-but-not-yet-transcribed rows.
-- Cannot include `now()` in the predicate (not IMMUTABLE — noted in
-- CLAUDE.md → Environment Gotchas). Filter by time at query time.
CREATE INDEX IF NOT EXISTS idx_call_sessions_pending_transcript
  ON call_sessions (ended_at)
  WHERE status = 'ended'
    AND recording_id IS NOT NULL
    AND transcript_fetched_at IS NULL;

ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;

-- Tenant isolation — B2b naming pattern (PR #237).
-- All four commands use the same fail-closed predicate; non-admins
-- (members + caregivers) can read every call in their org so the
-- profile timeline works for the whole team. Writes are service-role
-- only in Phase 1 (the webhook handler), so there's no admin gate
-- on insert/update/delete — the predicate alone is sufficient.
CREATE POLICY "tenant_isolation_call_sessions_select"
  ON call_sessions FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "tenant_isolation_call_sessions_insert"
  ON call_sessions FOR INSERT
  TO authenticated
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "tenant_isolation_call_sessions_update"
  ON call_sessions FOR UPDATE
  TO authenticated
  USING      (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid)
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "tenant_isolation_call_sessions_delete"
  ON call_sessions FOR DELETE
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "service_role_full_access_call_sessions"
  ON call_sessions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Sanity check — abort the deploy if anything went sideways.
DO $$
DECLARE
  v_table_exists boolean;
  v_policy_count int;
  v_default_expr text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'call_sessions'
  ) INTO v_table_exists;

  IF NOT v_table_exists THEN
    RAISE EXCEPTION 'call_sessions table missing after migration';
  END IF;

  -- Expect 4 tenant_isolation_* + 1 service_role_full_access_* = 5.
  SELECT count(*) INTO v_policy_count
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE c.relname = 'call_sessions'
    AND (
      p.polname ~ '^tenant_isolation_.*_(select|insert|update|delete)$'
      OR p.polname = 'service_role_full_access_call_sessions'
    );

  IF v_policy_count <> 5 THEN
    RAISE EXCEPTION
      'call_sessions: expected 5 RLS policies, found %', v_policy_count;
  END IF;

  -- Confirm org_id default uses the locked default_org_id() helper.
  SELECT pg_get_expr(d.adbin, d.adrelid)
    INTO v_default_expr
    FROM pg_attrdef d
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE c.relname = 'call_sessions' AND a.attname = 'org_id';

  IF v_default_expr IS NULL OR v_default_expr NOT LIKE '%default_org_id()%' THEN
    RAISE EXCEPTION
      'call_sessions.org_id default must reference default_org_id(); got: %',
      v_default_expr;
  END IF;
END
$$;
