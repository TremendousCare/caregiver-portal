
-- Automation log table: tracks every automation execution for dedup and audit
CREATE TABLE automation_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id TEXT NOT NULL,
  caregiver_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
  message_sent TEXT,
  error_detail TEXT,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for dedup lookups: has this rule already fired for this caregiver?
CREATE INDEX idx_automation_log_dedup ON automation_log (rule_id, caregiver_id);

-- Index for log viewer: recent entries first
CREATE INDEX idx_automation_log_recent ON automation_log (executed_at DESC);

-- Enable RLS
ALTER TABLE automation_log ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read logs
CREATE POLICY "allow_authenticated_read_automation_log"
  ON automation_log FOR SELECT
  TO authenticated
  USING (true);

-- Service role can insert (Edge Functions use service role key)
-- No authenticated INSERT policy needed — only Edge Functions write to this table
CREATE POLICY "allow_service_role_insert_automation_log"
  ON automation_log FOR INSERT
  TO service_role
  WITH CHECK (true);
