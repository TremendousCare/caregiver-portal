-- Lead Notification V1 — Dispatcher cron (PR 3 of 4).
--
-- Schedules the every-5-min pg_cron job that invokes the
-- dispatch-lead-notifications edge function. The function reads
-- `lead_notification_queue` rows enqueued by PR 1's trigger and
-- fans them out to SMS / Teams / toast per the org's
-- `organizations.settings.lead_notifications` config (PR 2).
--
-- Cadence:
--   • Every 5 minutes. Matches the interview-reminders and bookings-
--     poll cadence. Each tick claims up to 50 pending rows.
--
-- Idempotency:
--   • cron.unschedule wrapped in a guard so re-running this migration
--     is safe.
--   • Job-name 'dispatch-lead-notifications' is the canonical handle;
--     do not rename without dropping + recreating.
--
-- Production safety:
--   • The edge function is a no-op until at least one org flips
--     `lead_notifications.enabled = true` in Settings. Until then
--     every tick scans the queue, marks rows skipped_disabled, and
--     returns.
--   • Failures inside the function are caught per-row and logged in
--     `last_error`; a single bad lead does not stop the tick.

DO $$
BEGIN
  PERFORM cron.unschedule('dispatch-lead-notifications')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'dispatch-lead-notifications'
  );
EXCEPTION WHEN OTHERS THEN
  -- pg_cron unschedule occasionally races with itself on fresh
  -- projects; swallowing here keeps the migration idempotent.
  NULL;
END $$;

SELECT cron.schedule(
  'dispatch-lead-notifications',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/dispatch-lead-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);

-- Sanity check: the job exists. Catches a future PR that drops the
-- schedule without dropping this migration too.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'dispatch-lead-notifications'
  ) THEN
    RAISE EXCEPTION
      'dispatch-lead-notifications cron job did not register after migration';
  END IF;
END $$;
