-- Create call_transcriptions cache table
CREATE TABLE IF NOT EXISTS call_transcriptions (
  recording_id text PRIMARY KEY,
  transcript text NOT NULL,
  duration_seconds integer,
  language text DEFAULT 'en',
  created_at timestamptz DEFAULT now()
);

-- RLS: all authenticated can read, service_role inserts
ALTER TABLE call_transcriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read transcriptions"
  ON call_transcriptions FOR SELECT
  TO authenticated
  USING (true);
