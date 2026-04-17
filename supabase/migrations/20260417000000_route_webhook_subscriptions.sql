-- ═══════════════════════════════════════════════════════════════
-- Per-route RingCentral webhook subscriptions
--
-- Purpose:
--   Track one RingCentral webhook subscription per row in
--   communication_routes so that inbound SMS to ANY of our numbers
--   (main line, Onboarding/TAS, Scheduling/OC, future hires) fires
--   our webhook. Previously only the single extension tied to the
--   global RINGCENTRAL_JWT_TOKEN env var was subscribed.
--
-- Safety notes:
--   - PURELY ADDITIVE. Adds 4 nullable columns; no data changes.
--   - Existing code continues to work: the edge function falls back
--     to the env-var JWT when a route has no per-route JWT set.
--   - The pg_cron renewal job is idempotent and safe to re-run.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE communication_routes
  ADD COLUMN IF NOT EXISTS subscription_id          TEXT,
  ADD COLUMN IF NOT EXISTS subscription_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_last_error  TEXT,
  ADD COLUMN IF NOT EXISTS subscription_synced_at   TIMESTAMPTZ;

COMMENT ON COLUMN communication_routes.subscription_id IS
  'RingCentral webhook subscription ID for this route''s extension. Renewed daily by pg_cron.';
COMMENT ON COLUMN communication_routes.subscription_expires_at IS
  'When the current RC webhook subscription expires. Renewal cron runs well before this.';
COMMENT ON COLUMN communication_routes.subscription_last_error IS
  'Last error message from a failed subscribe/renew attempt. NULL when healthy.';
COMMENT ON COLUMN communication_routes.subscription_synced_at IS
  'Last time the subscribe/renew loop attempted this route (success or failure).';

-- ─── Daily cron: renew all route subscriptions ──────────────
-- RingCentral caps subscription lifetime at ~7 days, so we renew
-- every 24 hours. The edge function is idempotent: it will renew
-- existing subscriptions where possible, and create new ones where
-- renewal fails (404 / expired). Runs at 06:00 UTC (~2am ET) to
-- avoid business hours.

DO $$
BEGIN
  -- Drop any previous schedule with the same name so migration is re-runnable
  PERFORM cron.unschedule('renew-ringcentral-webhook-subscriptions')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'renew-ringcentral-webhook-subscriptions'
  );
EXCEPTION WHEN OTHERS THEN
  -- cron.unschedule raises if the job does not exist on some PG versions; ignore
  NULL;
END $$;

SELECT cron.schedule(
  'renew-ringcentral-webhook-subscriptions',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/ringcentral-webhook?action=subscribe',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);
