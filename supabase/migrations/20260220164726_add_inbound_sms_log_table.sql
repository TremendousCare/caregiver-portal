
-- Inbound SMS log for dedup tracking and audit trail
CREATE TABLE IF NOT EXISTS inbound_sms_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rc_message_id TEXT NOT NULL UNIQUE,
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  message_text TEXT,
  matched_entity_type TEXT,
  matched_entity_id TEXT,
  processed_at TIMESTAMPTZ DEFAULT now(),
  automation_fired BOOLEAN DEFAULT false
);

-- Index for fast dedup lookups
CREATE INDEX idx_inbound_sms_log_rc_id ON inbound_sms_log(rc_message_id);

-- Index for recent message queries
CREATE INDEX idx_inbound_sms_log_processed ON inbound_sms_log(processed_at DESC);

-- RLS: service_role can insert (webhook), authenticated users can read
ALTER TABLE inbound_sms_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read inbound SMS log"
  ON inbound_sms_log FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can insert inbound SMS log"
  ON inbound_sms_log FOR INSERT
  TO service_role
  WITH CHECK (true);
