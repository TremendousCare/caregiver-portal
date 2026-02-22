-- ═══════════════════════════════════════════════════════════════
-- Sequence Enrollments table + stop_on_response toggle
-- ═══════════════════════════════════════════════════════════════

-- 1. Enrollments table
CREATE TABLE IF NOT EXISTS client_sequence_enrollments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sequence_id TEXT NOT NULL REFERENCES client_sequences(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'completed')),
  current_step INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_by TEXT NOT NULL DEFAULT 'system',
  start_from_step INTEGER NOT NULL DEFAULT 0,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT CHECK (cancel_reason IN ('response_detected', 'manual', 'phase_changed') OR cancel_reason IS NULL),
  cancelled_by TEXT,
  completed_at TIMESTAMPTZ,
  last_step_executed_at TIMESTAMPTZ
);

-- Partial unique index: only one active enrollment per client per sequence
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_active_unique
  ON client_sequence_enrollments (client_id, sequence_id)
  WHERE status = 'active';

-- Index for cron queries: find all active enrollments efficiently
CREATE INDEX IF NOT EXISTS idx_enrollments_status
  ON client_sequence_enrollments (status)
  WHERE status = 'active';

-- Index for client profile lookups
CREATE INDEX IF NOT EXISTS idx_enrollments_client
  ON client_sequence_enrollments (client_id, started_at DESC);

-- RLS: all authenticated users full access (team tool pattern)
ALTER TABLE client_sequence_enrollments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'client_sequence_enrollments' AND policyname = 'Authenticated users full access'
  ) THEN
    CREATE POLICY "Authenticated users full access"
      ON client_sequence_enrollments FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Enable Realtime for UI updates
ALTER PUBLICATION supabase_realtime ADD TABLE client_sequence_enrollments;

-- 2. Add stop_on_response to client_sequences
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'client_sequences' AND column_name = 'stop_on_response'
  ) THEN
    ALTER TABLE client_sequences ADD COLUMN stop_on_response BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;
END $$;
