-- Rollback for 20260603100000_post_call_processor_cron_slow_to_5min.sql
-- Lives outside the auto-applied migrations folder; run manually via
-- psql ONLY if the cadence change must be reverted.
--
-- Restores the original every-minute schedule for post-call-processor.
-- NOTE: reverting cadence alone (without also reverting the edge function's
-- BATCH_SIZE=5 and the 429 circuit breaker) is safe — the per-minute cron
-- with a batch of 5 is still ~5 Heavy calls/min, at the RC ceiling but not
-- over it. Only revert this if the slower transcript lag is a problem AND
-- the rate-limit storm is confirmed resolved.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260603100000_post_call_processor_cron_slow_to_5min_down.sql

SELECT cron.schedule(
  'post-call-processor',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/post-call-processor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('triggered_at', now()::text),
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);
