
-- Create docusign_envelopes table (caregiver_id is text to match caregivers.id)
CREATE TABLE IF NOT EXISTS docusign_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id text UNIQUE NOT NULL,
  caregiver_id text NOT NULL REFERENCES caregivers(id),
  template_ids jsonb DEFAULT '[]'::jsonb,
  template_names jsonb DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'sent',
  sent_by text,
  sent_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  status_updated_at timestamptz DEFAULT now(),
  documents_uploaded boolean DEFAULT false,
  tasks_completed jsonb DEFAULT '[]'::jsonb,
  error_detail text
);

-- Indexes
CREATE INDEX idx_docusign_envelopes_caregiver ON docusign_envelopes(caregiver_id);
CREATE INDEX idx_docusign_envelopes_status_updated ON docusign_envelopes(status_updated_at DESC);

-- RLS
ALTER TABLE docusign_envelopes ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read
CREATE POLICY "Authenticated users can read docusign_envelopes"
  ON docusign_envelopes FOR SELECT
  TO authenticated
  USING (true);

-- Authenticated users can insert (sending envelopes)
CREATE POLICY "Authenticated users can insert docusign_envelopes"
  ON docusign_envelopes FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Authenticated users can update (for status changes)
CREATE POLICY "Authenticated users can update docusign_envelopes"
  ON docusign_envelopes FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Service role can do everything (for webhook Edge Function)
CREATE POLICY "Service role full access to docusign_envelopes"
  ON docusign_envelopes FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
