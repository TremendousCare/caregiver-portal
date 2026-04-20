-- Multi-user Outlook/Microsoft 365 access
-- Adds per-admin mailbox mapping so each logged-in admin reads/sends from their own M365 mailbox.
-- Backwards compatible: admins without mailbox_email fall back to the global app_settings.outlook_mailbox.

ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS mailbox_email TEXT;

-- Backfill: existing admins default to using their login email as their mailbox.
UPDATE user_roles
SET mailbox_email = email
WHERE mailbox_email IS NULL
  AND role = 'admin'
  AND email LIKE '%@%';

-- Seed Daniela (Talent Acquisition Specialist) as admin with her own mailbox.
INSERT INTO user_roles (email, role, mailbox_email)
VALUES ('daniela.hernandez@tremendouscareca.com', 'admin', 'daniela.hernandez@tremendouscareca.com')
ON CONFLICT (email) DO UPDATE
  SET role = 'admin',
      mailbox_email = COALESCE(user_roles.mailbox_email, EXCLUDED.mailbox_email);
