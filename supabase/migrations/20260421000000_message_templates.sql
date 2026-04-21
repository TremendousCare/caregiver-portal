-- ═══════════════════════════════════════════════════════════════
-- Message Templates — reusable SMS templates for 1:1 caregiver texts
--
-- Admins create/edit templates in Settings; all staff can select
-- them from the inline SMS composer to pre-fill the textarea with
-- a rendered (personalized) message they can then edit and send.
--
-- Placeholder format matches broadcastHelpers.renderTemplate:
--   {{firstName}}, {{lastName}}, {{fullName}}
-- Unknown placeholders render as empty strings (defensive).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE message_templates (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('onboarding', 'scheduling', 'general')),
  body TEXT NOT NULL,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT
);

-- Enforce unique names only among active (non-archived) templates.
-- Archiving + creating a new template with the same name is a
-- legitimate flow (e.g. "Interview Reminder v2" supersedes v1).
CREATE UNIQUE INDEX message_templates_active_name_unique
  ON message_templates (lower(name))
  WHERE is_archived = false;

CREATE INDEX message_templates_category_idx
  ON message_templates (category)
  WHERE is_archived = false;

-- ─── Row-Level Security ─────────────────────────────────────────
-- Mirrors automation_rules: all authenticated users can read;
-- only admins can insert/update/delete.

ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_authenticated_read_message_templates"
  ON message_templates FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "allow_admin_insert_message_templates"
  ON message_templates FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.email = lower(auth.jwt() ->> 'email')
        AND user_roles.role = 'admin'
    )
  );

CREATE POLICY "allow_admin_update_message_templates"
  ON message_templates FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.email = lower(auth.jwt() ->> 'email')
        AND user_roles.role = 'admin'
    )
  );

CREATE POLICY "allow_admin_delete_message_templates"
  ON message_templates FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.email = lower(auth.jwt() ->> 'email')
        AND user_roles.role = 'admin'
    )
  );

-- ─── Seed starter templates (one per category) ──────────────────
-- Admins can edit, archive, or extend these at any time.

INSERT INTO message_templates (name, category, body, created_by) VALUES
  (
    'Onboarding Welcome',
    'onboarding',
    'Hi {{firstName}}, welcome to Tremendous Care! We''re excited to have you on the team. Please complete your onboarding paperwork at your earliest convenience and let us know if you have any questions.',
    'system:seed'
  ),
  (
    'Shift Check-In',
    'scheduling',
    'Hi {{firstName}}, just checking in on your upcoming shift. Please reply to confirm you''re all set. Thanks!',
    'system:seed'
  ),
  (
    'General Follow-Up',
    'general',
    'Hi {{firstName}}, following up on our last conversation. Let me know when you have a moment to chat.',
    'system:seed'
  );
