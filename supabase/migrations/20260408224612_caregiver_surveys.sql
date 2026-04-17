-- Caregiver Pre-Screening Surveys
-- Configurable surveys sent automatically to new applicants.

CREATE TABLE IF NOT EXISTS survey_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  expires_hours integer NOT NULL DEFAULT 48,
  send_via text NOT NULL DEFAULT 'sms',
  sms_template text DEFAULT 'Hi {{first_name}}, thank you for applying to Tremendous Care! Please complete this brief screening survey to continue: {{survey_link}}',
  email_subject text DEFAULT 'Tremendous Care — Pre-Screening Survey',
  email_template text DEFAULT 'Hi {{first_name}},\n\nThank you for your interest in joining Tremendous Care! Please complete this brief pre-screening survey to continue your application:\n\n{{survey_link}}\n\nThis survey takes about 2 minutes. Please complete it within {{expires_hours}} hours.\n\nBest regards,\nTremendous Care Recruiting Team',
  auto_archive_disqualified boolean NOT NULL DEFAULT false,
  archive_reason text DEFAULT 'Pre-screening: did not meet requirements',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_template_id uuid NOT NULL REFERENCES survey_templates(id),
  caregiver_id text NOT NULL,
  token text NOT NULL UNIQUE,
  answers jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  qualification_results jsonb DEFAULT '[]'::jsonb,
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_via text,
  submitted_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '48 hours'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_survey_responses_token ON survey_responses (token);
CREATE INDEX idx_survey_responses_caregiver ON survey_responses (caregiver_id);
CREATE INDEX idx_survey_responses_status ON survey_responses (status) WHERE status = 'pending';

ALTER TABLE survey_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY survey_templates_auth ON survey_templates
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY survey_responses_auth ON survey_responses
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY survey_responses_anon_read ON survey_responses
  FOR SELECT USING (true);

CREATE POLICY survey_templates_anon_read ON survey_templates
  FOR SELECT USING (true);

CREATE POLICY survey_responses_anon_update ON survey_responses
  FOR UPDATE USING (true);
