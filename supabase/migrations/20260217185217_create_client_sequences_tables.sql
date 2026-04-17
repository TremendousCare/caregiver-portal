
-- Sequence definitions
CREATE TABLE IF NOT EXISTS client_sequences (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  trigger_phase TEXT DEFAULT '',
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT DEFAULT '',
  updated_by TEXT DEFAULT ''
);

ALTER TABLE client_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated full access on client_sequences" ON client_sequences
  FOR ALL USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- Sequence execution log
CREATE TABLE IF NOT EXISTS client_sequence_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sequence_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at BIGINT NOT NULL,
  executed_at BIGINT,
  error_detail TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE client_sequence_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read on client_sequence_log" ON client_sequence_log
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Service insert on client_sequence_log" ON client_sequence_log
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update on client_sequence_log" ON client_sequence_log
  FOR UPDATE USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_seq_log_client ON client_sequence_log(client_id);
CREATE INDEX IF NOT EXISTS idx_seq_log_scheduled ON client_sequence_log(scheduled_at) WHERE status = 'pending';
