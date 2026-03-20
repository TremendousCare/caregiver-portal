-- ── System Metrics Table ──
-- Lightweight, append-only metrics for agent observability.
-- Each Edge Function logs key events here for dashboarding.

CREATE TABLE IF NOT EXISTS system_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name TEXT NOT NULL,          -- 'message-router', 'ai-chat', 'outcome-analyzer', etc.
  event_type    TEXT NOT NULL,          -- 'invocation', 'classification', 'execution', 'error'
  duration_ms   INTEGER,               -- wall-clock time for the operation
  success       BOOLEAN DEFAULT TRUE,
  metadata      JSONB DEFAULT '{}',    -- function-specific data (tokens, action_type, error msg, etc.)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for dashboard queries (recent metrics by function)
CREATE INDEX idx_system_metrics_function_recent
  ON system_metrics (function_name, created_at DESC);

-- Index for error monitoring
CREATE INDEX idx_system_metrics_errors
  ON system_metrics (created_at DESC)
  WHERE success = FALSE;

-- Partition-friendly: auto-delete metrics older than 90 days via pg_cron
-- (keeps table size manageable without manual maintenance)
SELECT cron.schedule(
  'cleanup-old-metrics',
  '0 3 * * 0',  -- Weekly on Sunday at 3am UTC
  $$DELETE FROM system_metrics WHERE created_at < now() - interval '90 days';$$
);

-- RLS: authenticated users can read (for dashboard), only service_role can write
ALTER TABLE system_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read metrics"
  ON system_metrics FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can insert metrics"
  ON system_metrics FOR INSERT
  TO service_role
  WITH CHECK (true);

-- Enable Realtime for live dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE system_metrics;
