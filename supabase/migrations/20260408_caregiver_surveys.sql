-- Caregiver Pre-Screening Surveys
-- Configurable surveys sent automatically to new applicants.
-- Survey templates are customizable from Settings UI.
-- Responses are scored against qualification rules to auto-qualify, flag, or disqualify caregivers.

-- ═══════════════════════════════════════════════════════════════
-- Survey Templates — defines the survey structure and questions
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS survey_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  -- questions is a JSONB array of question objects:
  -- [{
  --   id: "q_abc123",
  --   text: "Are you legally authorized to work in the United States?",
  --   type: "yes_no" | "multiple_choice" | "free_text" | "number",
  --   required: true,
  --   options: ["Yes", "No"],          -- for multiple_choice
  --   qualification_rules: [{
  --     answer: "No",                   -- which answer triggers this rule
  --     action: "disqualify" | "flag" | "pass",
  --     reason: "Not authorized to work in the US"
  --   }]
  -- }]
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Settings
  enabled boolean NOT NULL DEFAULT true,
  expires_hours integer NOT NULL DEFAULT 48,
  send_via text NOT NULL DEFAULT 'sms',  -- 'sms', 'email', 'both'
  -- Message templates for SMS/email delivery
  sms_template text DEFAULT 'Hi {{first_name}}, thank you for applying to Tremendous Care! Please complete this brief screening survey to continue: {{survey_link}}',
  email_subject text DEFAULT 'Tremendous Care — Pre-Screening Survey',
  email_template text DEFAULT 'Hi {{first_name}},\n\nThank you for your interest in joining Tremendous Care! Please complete this brief pre-screening survey to continue your application:\n\n{{survey_link}}\n\nThis survey takes about 2 minutes. Please complete it within {{expires_hours}} hours.\n\nBest regards,\nTremendous Care Recruiting Team',
  -- Disqualification settings
  auto_archive_disqualified boolean NOT NULL DEFAULT false,
  archive_reason text DEFAULT 'Pre-screening: did not meet requirements',
  -- Metadata
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
-- Survey Responses — stores each caregiver's answers + outcome
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS survey_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_template_id uuid NOT NULL REFERENCES survey_templates(id),
  caregiver_id text NOT NULL,
  token text NOT NULL UNIQUE,
  -- answers is a JSONB object: { "q_abc123": "Yes", "q_def456": "3-5 years" }
  answers jsonb DEFAULT '{}'::jsonb,
  -- Qualification result after submission
  -- 'pending' (not yet submitted), 'qualified', 'flagged', 'disqualified'
  status text NOT NULL DEFAULT 'pending',
  -- Array of flag/disqualify reasons from qualification rules
  -- [{ question_id: "q_abc", answer: "No", action: "disqualify", reason: "..." }]
  qualification_results jsonb DEFAULT '[]'::jsonb,
  -- Timestamps
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_via text,  -- 'sms', 'email', 'both'
  submitted_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '48 hours'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup by token (public survey page validates by token)
CREATE INDEX idx_survey_responses_token ON survey_responses (token);

-- Find surveys for a caregiver
CREATE INDEX idx_survey_responses_caregiver ON survey_responses (caregiver_id);

-- Find pending surveys (for reminders, expiry checks)
CREATE INDEX idx_survey_responses_status ON survey_responses (status) WHERE status = 'pending';

-- RLS: service role only (edge functions use service role key)
ALTER TABLE survey_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_responses ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to manage templates (admin settings UI)
CREATE POLICY survey_templates_auth ON survey_templates
  FOR ALL USING (auth.role() = 'authenticated');

-- Allow authenticated users to read responses (admin dashboard)
CREATE POLICY survey_responses_auth ON survey_responses
  FOR ALL USING (auth.role() = 'authenticated');

-- Allow anonymous access to read survey template (for public survey page)
-- The public page fetches template via token → response → template join
CREATE POLICY survey_responses_anon_read ON survey_responses
  FOR SELECT USING (true);

CREATE POLICY survey_templates_anon_read ON survey_templates
  FOR SELECT USING (true);

-- Allow anonymous users to update their own response (submit answers)
CREATE POLICY survey_responses_anon_update ON survey_responses
  FOR UPDATE USING (true);
