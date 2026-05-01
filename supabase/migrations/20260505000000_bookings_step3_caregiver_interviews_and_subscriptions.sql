-- Bookings integration Step 3 — caregiver_interviews + bookings_subscriptions.
--
-- Step 3 brings inbound visibility: when a caregiver books an interview
-- through the Microsoft Bookings public page, Microsoft Graph delivers a
-- change notification to our `bookings-webhook` edge function, which
-- mirrors the appointment into `caregiver_interviews` so the portal
-- (caregiver detail card, AI context layer) can see it without polling
-- the Graph API.
--
-- Two new tables, both born multi-tenant per Phase B retrofit pattern
-- (see docs/SAAS_RETROFIT.md → Phase B). org_id NOT NULL from creation,
-- with a tenant-isolation RLS policy and an explicit service_role
-- bypass for edge functions.
--
-- Idempotent: re-running the migration is a no-op.

-- ─── caregiver_interviews ─────────────────────────────────────────────────
-- Local mirror of the subset of Microsoft Bookings appointments we care
-- about (ones tied to a caregiver in our pipeline). Source-of-truth for
-- the appointment itself remains Microsoft — we never edit it locally.
-- We re-fetch from Graph on every change notification and overwrite the
-- mirror. The mirror is what the UI reads.
CREATE TABLE IF NOT EXISTS caregiver_interviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT
                          DEFAULT public.default_org_id(),

  -- Microsoft Graph identity. Globally unique across all Bookings
  -- businesses in the tenant, so we use it as the dedup key.
  graph_appointment_id  text NOT NULL,
  business_id           text NOT NULL,
  service_id            text,
  service_name          text,
  staff_member_ids      text[] NOT NULL DEFAULT '{}',

  -- Caregiver match. Nullable because we may receive a booking before a
  -- matching caregiver record exists, or from a public booker who never
  -- went through the recruiting funnel. Nullable also tolerates manual
  -- re-matching from the UI later.
  caregiver_id          text REFERENCES caregivers(id) ON DELETE SET NULL,
  match_method          text CHECK (match_method IN ('phone', 'email', 'unmatched')),

  -- Appointment window. timestamptz so we can render in the user's TZ.
  start_at              timestamptz,
  end_at                timestamptz,

  -- Lifecycle. Microsoft's appointment object exposes cancellation via
  -- a `cancellationReason` / soft-delete pattern; we collapse to a
  -- single status field for UI sanity.
  status                text NOT NULL DEFAULT 'booked'
                          CHECK (status IN (
                            'booked', 'rescheduled', 'cancelled',
                            'completed', 'no_show'
                          )),

  -- Customer (caregiver-side) details captured at booking time.
  customer_name         text,
  customer_email        text,
  customer_phone        text,
  customer_notes        text,

  -- Online meeting join URL (Teams), if `is_online_meeting`.
  join_web_url          text,

  -- Raw Graph payload. Useful for debugging match misses and for
  -- forward-compatibility when Microsoft adds fields we don't yet
  -- mirror. Never read by the UI.
  raw_payload           jsonb,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- One row per Graph appointment per org. Org-scoped to stay correct
  -- after multi-org expansion (two customers booking the same Graph
  -- ID would be a Microsoft-side bug, but the constraint keeps us
  -- safe regardless).
  CONSTRAINT caregiver_interviews_unique_appt UNIQUE (org_id, graph_appointment_id)
);

CREATE INDEX IF NOT EXISTS idx_caregiver_interviews_org_start
  ON caregiver_interviews (org_id, start_at DESC);

CREATE INDEX IF NOT EXISTS idx_caregiver_interviews_caregiver
  ON caregiver_interviews (caregiver_id, start_at DESC)
  WHERE caregiver_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_caregiver_interviews_unmatched
  ON caregiver_interviews (org_id, created_at DESC)
  WHERE caregiver_id IS NULL;

ALTER TABLE caregiver_interviews ENABLE ROW LEVEL SECURITY;

-- Tenant isolation. Wrapping auth.jwt() in a SELECT triggers the
-- InitPlan optimization (see 20260214201225_harden_rls_policies.sql).
CREATE POLICY "tenant_isolation_caregiver_interviews"
  ON caregiver_interviews FOR ALL
  TO authenticated
  USING      (((SELECT auth.jwt()) ->> 'org_id')::uuid = org_id)
  WITH CHECK (((SELECT auth.jwt()) ->> 'org_id')::uuid = org_id);

CREATE POLICY "service_role_full_access_caregiver_interviews"
  ON caregiver_interviews FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── bookings_subscriptions ──────────────────────────────────────────────
-- One row per Microsoft Graph change-notification subscription we own
-- against a Bookings business. Graph caps subscription lifetime at
-- ~3 days for /solutions/bookingBusinesses/{id}/appointments, so we
-- renew on a daily cron. Stores enough state for the renew loop to
-- decide whether to renew an existing sub or create a new one.
CREATE TABLE IF NOT EXISTS bookings_subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT
                          DEFAULT public.default_org_id(),

  business_id           text NOT NULL,

  -- Graph subscription identity + lifecycle.
  subscription_id       text,
  expires_at            timestamptz,

  -- Notification URL (the bookings-webhook endpoint).
  notification_url      text,

  -- Shared secret echoed back in every Graph notification. We generate
  -- it on subscribe; the webhook validates it before mirroring.
  -- Without this any third party who guesses the URL could forge
  -- bookings into our database.
  client_state          text,

  last_renewed_at       timestamptz,
  last_synced_at        timestamptz,
  last_error            text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- One subscription per business per org. The renewal loop upserts on
  -- this constraint.
  CONSTRAINT bookings_subscriptions_unique_business UNIQUE (org_id, business_id)
);

CREATE INDEX IF NOT EXISTS idx_bookings_subscriptions_org
  ON bookings_subscriptions (org_id);

CREATE INDEX IF NOT EXISTS idx_bookings_subscriptions_expiring
  ON bookings_subscriptions (expires_at)
  WHERE subscription_id IS NOT NULL;

ALTER TABLE bookings_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_bookings_subscriptions"
  ON bookings_subscriptions FOR ALL
  TO authenticated
  USING      (((SELECT auth.jwt()) ->> 'org_id')::uuid = org_id)
  WITH CHECK (((SELECT auth.jwt()) ->> 'org_id')::uuid = org_id);

CREATE POLICY "service_role_full_access_bookings_subscriptions"
  ON bookings_subscriptions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── updated_at maintenance ──────────────────────────────────────────────
-- Both tables track updated_at — wire a generic touch trigger so any
-- mirror refresh from the webhook bumps it.

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_caregiver_interviews_updated_at ON caregiver_interviews;
CREATE TRIGGER trg_caregiver_interviews_updated_at
  BEFORE UPDATE ON caregiver_interviews
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_bookings_subscriptions_updated_at ON bookings_subscriptions;
CREATE TRIGGER trg_bookings_subscriptions_updated_at
  BEFORE UPDATE ON bookings_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─── Daily cron: renew Microsoft Graph subscriptions ─────────────────────
-- Graph caps Bookings appointment subscriptions at ~3 days. We renew
-- daily at 05:30 UTC (~30 minutes before the RingCentral renewal job)
-- to stay well within the window. The edge function is idempotent: it
-- will renew where possible and create a new subscription where renewal
-- fails (404 / expired / never subscribed).

DO $$
BEGIN
  PERFORM cron.unschedule('renew-bookings-graph-subscriptions')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'renew-bookings-graph-subscriptions'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'renew-bookings-graph-subscriptions',
  '30 5 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/bookings-integration',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('action', 'renew_subscriptions'),
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);
