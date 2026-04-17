
-- Automation rules table: stores configurable automation rules
CREATE TABLE automation_rules (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('new_caregiver', 'days_inactive', 'interview_scheduled')),
  conditions JSONB NOT NULL DEFAULT '{}',
  action_type TEXT NOT NULL CHECK (action_type IN ('send_sms', 'send_email')),
  action_config JSONB NOT NULL DEFAULT '{}',
  message_template TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

-- Enable RLS
ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read rules
CREATE POLICY "allow_authenticated_read_automation_rules"
  ON automation_rules FOR SELECT
  TO authenticated
  USING (true);

-- Only admins can insert rules
CREATE POLICY "allow_admin_insert_automation_rules"
  ON automation_rules FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.email = lower(auth.jwt() ->> 'email')
        AND user_roles.role = 'admin'
    )
  );

-- Only admins can update rules
CREATE POLICY "allow_admin_update_automation_rules"
  ON automation_rules FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.email = lower(auth.jwt() ->> 'email')
        AND user_roles.role = 'admin'
    )
  );

-- Only admins can delete rules
CREATE POLICY "allow_admin_delete_automation_rules"
  ON automation_rules FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.email = lower(auth.jwt() ->> 'email')
        AND user_roles.role = 'admin'
    )
  );
