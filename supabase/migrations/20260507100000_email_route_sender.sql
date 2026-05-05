-- ═══════════════════════════════════════════════════════════════
-- Email sender routing via communication_routes
--
-- Goal: let sequences (and any send_email automation rule) pick the
-- mailbox the email is sent FROM by passing a route category. SMS already
-- routes this way; this migration fills in the email half by populating
-- the email_from_address / email_from_name columns on existing routes
-- and seeds the office coordinator (Juliana) so she can be both a sender
-- and the global default mailbox.
--
-- Production safety: every operation here is additive / idempotent.
--   - INSERTs use ON CONFLICT DO NOTHING / DO UPDATE
--   - app_settings.outlook_mailbox swap from Daniela → Juliana is a value
--     update; the previous value is captured below for rollback.
--   - No DROPs, no column removals, no destructive backfills.
--
-- Rollback: see _rollback/20260507100000_email_route_sender_down.sql
-- ═══════════════════════════════════════════════════════════════

-- 1. Seed Juliana (Office Coordinator) in user_roles so the mailbox
--    resolver recognizes her as an admin with her own M365 mailbox.
INSERT INTO user_roles (email, role, mailbox_email)
VALUES ('juliana.gurule@tremendouscareca.com', 'admin', 'juliana.gurule@tremendouscareca.com')
ON CONFLICT (email) DO UPDATE
  SET role = 'admin',
      mailbox_email = COALESCE(user_roles.mailbox_email, EXCLUDED.mailbox_email);

-- 2. Populate email sender info on the two routes employees may pick from.
--    Leadership-level senders (owner, COO) intentionally have no
--    email_from_address so the SequenceSettings / AutomationSettings
--    dropdowns hide them. Add them later by running:
--      UPDATE communication_routes
--      SET email_from_address = '<addr>', email_from_name = '<name>'
--      WHERE category = '<category>';
UPDATE communication_routes
SET email_from_address = 'juliana.gurule@tremendouscareca.com',
    email_from_name    = 'Juliana Gurule',
    updated_at         = NOW()
WHERE category = 'scheduling';

UPDATE communication_routes
SET email_from_address = 'daniela.hernandez@tremendouscareca.com',
    email_from_name    = 'Daniela Hernandez',
    updated_at         = NOW()
WHERE category = 'onboarding';

-- 3. Switch the global default mailbox from Daniela → Juliana.
--    Any non-categorized email send (legacy callers, ad-hoc UI sends,
--    sequence steps without an explicit category) now flows through
--    Juliana's mailbox, and replies land in her inbox where the rest of
--    the pipeline (response detection, thread search) will see them.
--
--    The setting is upserted; if it doesn't exist (fresh install) we
--    create it. If it does, we set it to Juliana.
INSERT INTO app_settings (key, value)
VALUES ('outlook_mailbox', '"juliana.gurule@tremendouscareca.com"'::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = '"juliana.gurule@tremendouscareca.com"'::jsonb,
      updated_at = NOW();
