-- Rollback for 20260507100000_email_route_sender.sql
--
-- Restores prior global default mailbox (Daniela) and clears the email
-- columns we populated on communication_routes. Leaves Juliana's
-- user_roles entry in place — that's harmless and removing it would
-- break any per-admin mailbox routing that uses it.

UPDATE app_settings
SET value = '"daniela.hernandez@tremendouscareca.com"'::jsonb,
    updated_at = NOW()
WHERE key = 'outlook_mailbox';

UPDATE communication_routes
SET email_from_address = NULL,
    email_from_name    = NULL,
    updated_at         = NOW()
WHERE category IN ('scheduling', 'onboarding');
