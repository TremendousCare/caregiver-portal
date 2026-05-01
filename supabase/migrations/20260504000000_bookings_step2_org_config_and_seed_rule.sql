-- Bookings integration Step 2 — per-org bookings config + seed automation rule
--
-- Stores Tremendous Care's Microsoft 365 Bookings configuration in
-- organizations.settings.bookings so the {{booking_url}} merge field in
-- automation rules can resolve to the right per-org URL. Multi-tenant
-- ready: each customer org gets its own bookings block when onboarded.
--
-- Seeds the automation rule that fires when the "Send Interview Link" task
-- is completed, sending an SMS with the booking page URL via RingCentral.
-- Shipped DISABLED — admins flip it on in Automations Settings after
-- reviewing the SMS template (production safety: no surprise sends on
-- the next task completion after deploy).
--
-- Both operations are idempotent and safe to re-run.

-- ─── Per-org bookings config ──────────────────────────────────────────────
-- IDs captured from Microsoft Graph after the Step 1 verify call.
-- business_id      — Bookings business email-format ID (used in /solutions/bookingBusinesses/{id} paths)
-- service_id       — "Caregiver Interview" service inside that business
-- default_staff_id — Daniela Hernandez (only staff currently assigned to the service)
-- public_url       — public-facing self-service booking page URL
UPDATE public.organizations
SET settings = settings || jsonb_build_object(
  'bookings', jsonb_build_object(
    'business_id',       'TremendousCareCaregiverInterviews@themedconnection.com',
    'service_id',        '63251fbe-3727-45d7-9be4-0d13619cf74d',
    'default_staff_id',  '81612be5-14ef-4b94-b059-73e310aad598',
    'public_url',        'https://outlook.office.com/book/TremendousCareCaregiverInterviews@themedconnection.com/'
  )
),
updated_at = now()
WHERE slug = 'tremendous-care'
  AND (settings -> 'bookings') IS NULL;

-- ─── Seed automation rule ─────────────────────────────────────────────────
-- Idempotent on intent (no duplicate rule for the same task_id), not on
-- a fixed UUID — admins can later edit message_template / action_config /
-- enabled in Automations Settings without losing changes on re-deploy.
INSERT INTO public.automation_rules (
  id,
  name,
  trigger_type,
  conditions,
  action_type,
  action_config,
  message_template,
  enabled,
  entity_type,
  created_by,
  updated_by
)
SELECT
  gen_random_uuid(),
  'Send Interview Booking Link',
  'task_completed',
  jsonb_build_object('task_id', 'send_interview_link'),
  'send_sms',
  '{}'::jsonb,
  'Hi {{first_name}}! It''s Tremendous Care. Thanks for your interest in becoming a caregiver. Please pick a time for your interview here: {{booking_url}}',
  false,  -- ships disabled; admin reviews template + flips on in Automations Settings
  'caregiver',
  'system:bookings_integration',
  'system:bookings_integration'
WHERE NOT EXISTS (
  SELECT 1 FROM public.automation_rules
  WHERE trigger_type = 'task_completed'
    AND conditions ->> 'task_id' = 'send_interview_link'
);
