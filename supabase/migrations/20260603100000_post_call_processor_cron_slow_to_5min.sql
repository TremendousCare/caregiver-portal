-- ─────────────────────────────────────────────────────────────────
-- Slow the post-call-processor cron from every minute to every 5 minutes
--
-- Incident (2026-05-27 → 2026-05-29): RingCentral API calls spiked to
-- ~144k/week with an ~88% error rate (CMN-301 / HTTP 429 "Request rate
-- exceeded"). The lead/client "Messages" tab went blank because
-- get-communications' message-store + call-log reads were being starved
-- on the shared per-extension RingCentral "Heavy" API bucket
-- (10 requests / 60s, 60s penalty).
--
-- Root cause was a self-inflicted retry storm out of post-call-processor:
-- it ran EVERY MINUTE and pulled a batch of 25 transcript-pending calls,
-- each costing at least one Heavy call (recording download for Whisper, or
-- a RingSense insights GET). 25 Heavy calls/minute against a 10/60s ceiling
-- kept the bucket in perpetual penalty, so transcription stalled AND every
-- other consumer on that extension (the interactive Messages tab) got 429'd.
--
-- Fix has three parts; this migration is part 1 (cadence). Parts 2 and 3
-- ship in the same PR on the edge function:
--   1. (here) cron 1min → 5min, so background transcription leaves the
--      Heavy bucket idle most of the time for interactive reads.
--   2. BATCH_SIZE 25 → 5, so a single tick can't exceed the Heavy ceiling.
--   3. A 429-aware circuit breaker that halts the batch the moment the
--      bucket signals penalty, instead of firing the rest of the batch into
--      a guaranteed-reject window.
--
-- Transcript lag goes from "~under a minute" to "~a few minutes," which is
-- well within the back office's tolerance and the price of not melting the
-- shared RC quota. The per-minute cadence was never required — calls finish
-- materialising their recording within ~30s and the give-up window is 24h.
--
-- Idempotent: cron.schedule on an existing jobname updates the schedule in
-- place (it does not create a duplicate). The post-function guard asserts
-- exactly one row remains.
--
-- Rollback: see _rollback/20260603100000_post_call_processor_cron_slow_to_5min_down.sql
-- (restores the '* * * * *' every-minute schedule).
-- ─────────────────────────────────────────────────────────────────

SELECT cron.schedule(
  'post-call-processor',
  '*/5 * * * *',
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

DO $$
DECLARE
  v_job_count int;
  v_schedule  text;
BEGIN
  SELECT count(*), max(schedule) INTO v_job_count, v_schedule
  FROM cron.job
  WHERE jobname = 'post-call-processor';

  IF v_job_count <> 1 THEN
    RAISE EXCEPTION
      'post-call-processor cron job: expected 1 row in cron.job, found %', v_job_count;
  END IF;

  IF v_schedule <> '*/5 * * * *' THEN
    RAISE EXCEPTION
      'post-call-processor cron job: expected schedule ''*/5 * * * *'', found %', v_schedule;
  END IF;
END
$$;
