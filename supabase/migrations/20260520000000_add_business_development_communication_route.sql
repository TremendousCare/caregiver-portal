-- Add a Business Development (BD) communication route.
--
-- Amy Dutton is the first Business Development Representative on the team
-- (see 20260518010000_seed_amy_dutton_communication_setup.sql). The three
-- existing routes — general, onboarding (TAS), scheduling (OC) — do not
-- represent BD outreach, so BD sequence steps and ad-hoc messages have
-- nowhere to land. This migration adds the row so the route shows up in:
--
--   • SequenceSettings.jsx "Send from" dropdown for client sequence steps
--   • SMSComposeBar.jsx outbound-line picker
--   • AdminSettings → Communication Routes (so the JWT can be pasted in)
--
-- Both UI consumers query `communication_routes` directly and gate the
-- dropdown on `is_active = true AND sms_from_number IS NOT NULL AND
-- sms_vault_secret_name IS NOT NULL`. The vault secret is populated by
-- the existing set_route_ringcentral_jwt(p_category, p_jwt) RPC when an
-- admin pastes the BD JWT in Admin Settings. So this row is intentionally
-- inserted with sms_from_number populated and sms_vault_secret_name NULL —
-- the route appears in the admin UI immediately but stays hidden from
-- sequence authors and message senders until the JWT is set.
--
-- email_from_address is left NULL: the user has scoped this work to SMS
-- sequences for now. BD email-from configuration can be added later via
-- the same Admin Settings UI (UPDATE communication_routes …) without a
-- new migration.
--
-- Production safety: pure additive INSERT, ON CONFLICT DO NOTHING so
-- re-running is a no-op. Rollback at
-- _rollback/20260520000000_add_business_development_communication_route_down.sql.

INSERT INTO public.communication_routes (
  category,
  label,
  description,
  sms_from_number,
  is_default,
  is_active,
  sort_order
)
VALUES (
  'business_development',
  'Business Development (BD)',
  'Outbound texts from the Business Development team. Outreach to facilities, agencies, referral sources, and prospects. Currently assigned to Amy Dutton.',
  '+19498671046',
  false,
  true,
  40
)
ON CONFLICT (category) DO NOTHING;
