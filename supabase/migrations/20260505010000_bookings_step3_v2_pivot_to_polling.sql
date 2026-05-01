-- Bookings integration Step 3 v2 — pivot from webhook to polling.
--
-- Microsoft Graph does NOT support change-notification subscriptions
-- against /solutions/bookingBusinesses/{id}/appointments. The Step 3 v1
-- migration (20260505000000) shipped a webhook architecture that Graph
-- silently rejects — confirmed in production with the error
-- "Invalid 'changeType' attribute: 'created'." The Microsoft-recommended
-- workaround for Bookings visibility is polling, so we pivot:
--
--   * Drop the now-useless `bookings_subscriptions` table (empty).
--   * Unschedule the daily Graph subscription renewal cron.
--   * Schedule a new 5-minute polling cron that calls
--     `bookings-integration` with action=poll_appointments.
--
-- `caregiver_interviews` keeps its full schema and all RLS policies —
-- the data shape is identical whether sourced from webhook or polling.
-- The bookings-webhook edge function is removed from the repo in this
-- same PR and stops being redeployed; the deployed copy in Supabase is
-- harmless (Graph never calls it) and can be deleted manually from the
-- Functions dashboard for hygiene.
--
-- Idempotent: re-running is a no-op.

-- ─── 1. Drop the empty bookings_subscriptions table ──────────────────────
-- Safe: the table only ever held one row in production, and that row's
-- subscription_id was NULL because Graph rejected the subscribe call.
-- No operational data is lost. CASCADE is unnecessary — nothing
-- references this table.
DROP TABLE IF EXISTS public.bookings_subscriptions;

-- ─── 2. Unschedule the now-pointless daily renewal cron ──────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('renew-bookings-graph-subscriptions')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'renew-bookings-graph-subscriptions'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- ─── 3. Schedule the new 5-minute polling cron ──────────────────────────
-- Calls bookings-integration with action=poll_appointments. The edge
-- function loops over every org with settings.bookings.business_id
-- set, lists appointments via Graph, normalizes/matches/upserts into
-- caregiver_interviews. Idempotent thanks to the unique constraint on
-- (org_id, graph_appointment_id).
--
-- Cadence rationale: 5 minutes is the sweet spot between "real-time
-- enough for human use" and "low enough volume that nothing in logs
-- gets noisy." ~12 calls/hour per org is well under any quota
-- (Supabase function invocations, Graph API limits, DB write load).

DO $$
BEGIN
  PERFORM cron.unschedule('poll-bookings-appointments')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'poll-bookings-appointments'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'poll-bookings-appointments',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/bookings-integration',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('action', 'poll_appointments'),
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);
