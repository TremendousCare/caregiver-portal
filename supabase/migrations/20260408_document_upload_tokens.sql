-- Document Upload Tokens: secure, time-limited links for caregivers to upload documents
-- Supports the "Request Documents" feature — staff sends a link, caregiver uploads via public page

CREATE TABLE IF NOT EXISTS document_upload_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id text NOT NULL,
  token text NOT NULL UNIQUE,
  requested_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

-- Fast lookup by token (the public page validates by token)
CREATE INDEX idx_upload_tokens_token ON document_upload_tokens (token);

-- Find active requests for a caregiver
CREATE INDEX idx_upload_tokens_caregiver ON document_upload_tokens (caregiver_id);

-- Enable realtime for live status updates in the portal
ALTER TABLE document_upload_tokens REPLICA IDENTITY FULL;

-- RLS: service role only (edge functions use service role key)
ALTER TABLE document_upload_tokens ENABLE ROW LEVEL SECURITY;
