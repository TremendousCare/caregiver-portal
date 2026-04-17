CREATE TABLE IF NOT EXISTS system_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  duration_ms   INTEGER,
  success       BOOLEAN DEFAULT TRUE,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_system_metrics_function_recent
  ON system_metrics (function_name, created_at DESC);

CREATE INDEX idx_system_metrics_errors
  ON system_metrics (created_at DESC)
  WHERE success = FALSE;

SELECT cron.schedule(
  'cleanup-old-metrics',
  '0 3 * * 0',
  $$DELETE FROM system_metrics WHERE created_at < now() - interval '90 days';$$
);

ALTER TABLE system_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read metrics"
  ON system_metrics FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can insert metrics"
  ON system_metrics FOR INSERT
  TO service_role
  WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE system_metrics;
