-- ─── Custom E-Signature Tables ───
-- Replaces DocuSign dependency with a built-in signing system.
-- Signed PDFs flow to SharePoint via existing sharepoint-docs edge function.

-- ─── 1. esign_templates ───
-- Reusable document templates with field definitions for signature placement.
CREATE TABLE IF NOT EXISTS esign_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  file_name text NOT NULL,
  file_storage_path text NOT NULL,
  file_page_count int NOT NULL DEFAULT 1,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  task_name text,
  document_type text,
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ─── 2. esign_envelopes ───
-- Tracks each signing request sent to a caregiver.
CREATE TABLE IF NOT EXISTS esign_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id text NOT NULL,
  template_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  template_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'viewed', 'signed', 'declined', 'expired', 'voided')),
  signing_token text UNIQUE NOT NULL,
  sent_via text DEFAULT 'sms'
    CHECK (sent_via IN ('sms', 'email', 'both')),
  sent_by text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  viewed_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  signer_ip text,
  signer_user_agent text,
  document_hash text,
  signature_data jsonb,
  documents_uploaded boolean NOT NULL DEFAULT false,
  tasks_completed jsonb DEFAULT '[]'::jsonb,
  audit_trail jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_esign_envelopes_caregiver ON esign_envelopes (caregiver_id, sent_at DESC);
CREATE INDEX idx_esign_envelopes_token ON esign_envelopes (signing_token);
CREATE INDEX idx_esign_envelopes_status ON esign_envelopes (status) WHERE status NOT IN ('signed', 'voided');
CREATE INDEX idx_esign_templates_active ON esign_templates (active, sort_order) WHERE active = true;

-- ─── 3. Supabase Storage bucket for template PDFs ───
INSERT INTO storage.buckets (id, name, public)
VALUES ('esign-templates', 'esign-templates', false)
ON CONFLICT (id) DO NOTHING;

-- ─── 4. RLS ───
ALTER TABLE esign_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE esign_envelopes ENABLE ROW LEVEL SECURITY;

-- Authenticated users (team members) can manage templates and envelopes
CREATE POLICY "Authenticated users can manage esign_templates"
  ON esign_templates FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can manage esign_envelopes"
  ON esign_envelopes FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Service role (edge functions) needs full access
CREATE POLICY "Service role full access to esign_templates"
  ON esign_templates FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access to esign_envelopes"
  ON esign_envelopes FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Storage policies for esign-templates bucket
CREATE POLICY "Authenticated users can upload esign templates"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'esign-templates');

CREATE POLICY "Authenticated users can read esign templates"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'esign-templates');

CREATE POLICY "Service role can read esign templates"
  ON storage.objects FOR SELECT
  TO service_role
  USING (bucket_id = 'esign-templates');

-- ─── 5. Realtime ───
ALTER PUBLICATION supabase_realtime ADD TABLE esign_envelopes;

-- ─── 6. Trigger for planner notification on signing completion ───
CREATE OR REPLACE FUNCTION notify_planner_esign_completed()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'signed' AND (OLD.status IS DISTINCT FROM 'signed') THEN
    PERFORM pg_notify('esign_completed', json_build_object(
      'envelope_id', NEW.id,
      'caregiver_id', NEW.caregiver_id,
      'template_names', NEW.template_names
    )::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_esign_completed
  AFTER UPDATE ON esign_envelopes
  FOR EACH ROW
  EXECUTE FUNCTION notify_planner_esign_completed();
