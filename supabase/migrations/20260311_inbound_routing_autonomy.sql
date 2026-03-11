-- ═══════════════════════════════════════════════════════════════
-- Inbound Message Routing + Graduated Autonomy Framework
-- Phase 1: message_routing_queue, ai_suggestions
-- Phase 2: autonomy_config
--
-- Purpose: Enable the AI assistant to process inbound messages
-- (SMS now, email later) asynchronously, classify intent,
-- draft responses, and take action based on configurable
-- autonomy levels (L1 Suggest → L2 Confirm → L3 Notify → L4 Auto).
-- ═══════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════
-- 1. message_routing_queue
-- Queue for inbound messages awaiting AI processing.
-- Webhook inserts fire-and-forget; message-router cron processes.
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS message_routing_queue (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel               TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  direction             TEXT NOT NULL DEFAULT 'inbound',

  -- Source data
  external_message_id   TEXT,
  sender_identifier     TEXT NOT NULL,
  recipient_identifier  TEXT,
  message_text          TEXT,
  message_subject       TEXT,
  raw_payload           JSONB,

  -- Matching results (copied from webhook processing)
  matched_entity_type   TEXT CHECK (matched_entity_type IN ('caregiver', 'client')),
  matched_entity_id     TEXT,
  matched_entity_name   TEXT,

  -- Processing status
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'skipped')),
  processing_started_at TIMESTAMPTZ,
  processed_at          TIMESTAMPTZ,
  attempts              INTEGER NOT NULL DEFAULT 0,
  error_detail          TEXT,

  -- AI classification results (filled by message-router)
  intent                TEXT,
  confidence            NUMERIC(3,2),
  suggested_action      TEXT,
  suggested_action_params JSONB,
  drafted_response      TEXT,
  ai_reasoning          TEXT,

  -- Autonomy routing
  autonomy_level        TEXT CHECK (autonomy_level IN ('L1', 'L2', 'L3', 'L4')),
  execution_status      TEXT CHECK (execution_status IN (
    'suggested', 'pending_approval', 'approved', 'executed', 'rejected', 'expired'
  )),
  executed_at           TIMESTAMPTZ,
  executed_by           TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Processor picks oldest pending rows
CREATE INDEX IF NOT EXISTS idx_mrq_pending
  ON message_routing_queue (created_at ASC)
  WHERE status = 'pending';

-- Notification center queries by execution status
CREATE INDEX IF NOT EXISTS idx_mrq_execution
  ON message_routing_queue (execution_status)
  WHERE execution_status IN ('suggested', 'pending_approval');

-- Entity lookup
CREATE INDEX IF NOT EXISTS idx_mrq_entity
  ON message_routing_queue (matched_entity_id);

-- Dedup by external message ID
CREATE INDEX IF NOT EXISTS idx_mrq_external
  ON message_routing_queue (external_message_id);

-- RLS: authenticated can read, service role has full access
ALTER TABLE message_routing_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read message_routing_queue"
  ON message_routing_queue FOR SELECT TO authenticated USING (true);

-- Enable Realtime for live UI updates
ALTER PUBLICATION supabase_realtime ADD TABLE message_routing_queue;


-- ══════════════════════════════════════════════
-- 2. autonomy_config
-- Per-action autonomy level settings.
-- Controls what the AI can do without human approval.
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS autonomy_config (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  action_type             TEXT NOT NULL,
  entity_type             TEXT NOT NULL DEFAULT 'caregiver'
                          CHECK (entity_type IN ('caregiver', 'client')),
  context                 TEXT NOT NULL DEFAULT 'inbound_routing'
                          CHECK (context IN ('inbound_routing', 'ai_chat', 'automation')),

  autonomy_level          TEXT NOT NULL DEFAULT 'L2'
                          CHECK (autonomy_level IN ('L1', 'L2', 'L3', 'L4')),

  -- Auto-promotion tracking
  consecutive_approvals   INTEGER NOT NULL DEFAULT 0,
  total_approvals         INTEGER NOT NULL DEFAULT 0,
  total_rejections        INTEGER NOT NULL DEFAULT 0,
  auto_promote_threshold  INTEGER DEFAULT 10,
  auto_demote_on_reject   BOOLEAN DEFAULT true,
  max_autonomy_level      TEXT DEFAULT 'L3'
                          CHECK (max_autonomy_level IN ('L1', 'L2', 'L3', 'L4')),

  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by              TEXT,

  UNIQUE (action_type, entity_type, context)
);

-- RLS: authenticated can read, admins can modify
ALTER TABLE autonomy_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read autonomy_config"
  ON autonomy_config FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can insert autonomy_config"
  ON autonomy_config FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE email = auth.jwt() ->> 'email' AND role = 'admin')
  );

CREATE POLICY "Admins can update autonomy_config"
  ON autonomy_config FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_roles WHERE email = auth.jwt() ->> 'email' AND role = 'admin')
  );

-- Seed with conservative defaults
INSERT INTO autonomy_config (action_type, entity_type, context, autonomy_level, max_autonomy_level) VALUES
  -- Inbound routing: SMS/email replies start at Confirm
  ('send_sms',       'caregiver', 'inbound_routing', 'L2', 'L3'),
  ('send_sms',       'client',    'inbound_routing', 'L2', 'L3'),
  ('send_email',     'caregiver', 'inbound_routing', 'L2', 'L3'),
  ('send_email',     'client',    'inbound_routing', 'L2', 'L3'),
  -- Phase changes start at Suggest (conservative)
  ('update_phase',   'caregiver', 'inbound_routing', 'L1', 'L2'),
  ('update_phase',   'client',    'inbound_routing', 'L1', 'L2'),
  -- Task completion starts at Suggest
  ('complete_task',  'caregiver', 'inbound_routing', 'L1', 'L3'),
  ('complete_task',  'client',    'inbound_routing', 'L1', 'L3'),
  -- Notes are always auto (low risk)
  ('add_note',       'caregiver', 'inbound_routing', 'L4', 'L4'),
  ('add_note',       'client',    'inbound_routing', 'L4', 'L4')
ON CONFLICT (action_type, entity_type, context) DO NOTHING;


-- ══════════════════════════════════════════════
-- 3. ai_suggestions
-- The notification center data. Each row represents
-- something the AI wants to do (or has done).
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_type       TEXT NOT NULL
                    CHECK (source_type IN ('inbound_sms', 'inbound_email', 'proactive', 'outcome')),
  source_id         UUID,

  -- Entity reference
  entity_type       TEXT CHECK (entity_type IN ('caregiver', 'client')),
  entity_id         TEXT,
  entity_name       TEXT,

  -- What the AI suggests
  suggestion_type   TEXT NOT NULL
                    CHECK (suggestion_type IN ('reply', 'action', 'alert', 'follow_up')),
  action_type       TEXT,
  title             TEXT NOT NULL,
  detail            TEXT,
  drafted_content   TEXT,
  action_params     JSONB,

  -- Intent classification
  intent            TEXT,
  intent_confidence NUMERIC(3,2),

  -- Autonomy
  autonomy_level    TEXT NOT NULL
                    CHECK (autonomy_level IN ('L1', 'L2', 'L3', 'L4')),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending', 'approved', 'rejected',
                      'executed', 'expired', 'auto_executed'
                    )),

  -- Resolution
  resolved_at       TIMESTAMPTZ,
  resolved_by       TEXT,
  rejection_reason  TEXT,

  -- Cost tracking
  input_tokens      INTEGER,
  output_tokens     INTEGER,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
);

-- Notification center queries pending suggestions
CREATE INDEX IF NOT EXISTS idx_suggestions_pending
  ON ai_suggestions (created_at DESC)
  WHERE status = 'pending';

-- Entity lookup
CREATE INDEX IF NOT EXISTS idx_suggestions_entity
  ON ai_suggestions (entity_id);

-- RLS: authenticated can read and update (for approve/reject), service role full access
ALTER TABLE ai_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read ai_suggestions"
  ON ai_suggestions FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can update ai_suggestions"
  ON ai_suggestions FOR UPDATE TO authenticated USING (true);

-- Enable Realtime for live notification updates
ALTER PUBLICATION supabase_realtime ADD TABLE ai_suggestions;


-- ══════════════════════════════════════════════
-- 4. pg_cron — message-router every 2 minutes
-- Same vault-secret pattern as intake-processor.
-- ══════════════════════════════════════════════

SELECT cron.schedule(
  'process-message-routing',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1) || '/functions/v1/message-router',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS request_id;
  $$
);
