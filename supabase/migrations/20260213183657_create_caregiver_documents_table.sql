
CREATE TABLE caregiver_documents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  caregiver_id TEXT NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  sharepoint_file_id TEXT,
  sharepoint_web_url TEXT,
  file_size BIGINT DEFAULT 0,
  uploaded_by TEXT DEFAULT '',
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT DEFAULT ''
);

ALTER TABLE caregiver_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access" ON caregiver_documents
  FOR ALL USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE INDEX idx_caregiver_docs_cg ON caregiver_documents(caregiver_id);
