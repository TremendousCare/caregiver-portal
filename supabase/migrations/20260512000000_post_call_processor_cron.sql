-- Schedule the post-call processor cron.
--
-- The edge function `post-call-processor` walks every ended call_session
-- whose recording_id is set and whose transcript has not yet been
-- fetched (the partial index `idx_call_sessions_pending_transcript`
-- from migration 20260511000002 narrows the scan to those rows). For
-- each pending row it:
--
--   1. Calls call-transcription to populate call_transcriptions
--      (RC-native or Whisper, decided per-org in
--      communication_voice_config.transcription_provider).
--   2. Stamps call_sessions.transcript_fetched_at.
--   3. Appends a {type:'call'} note to the matched caregiver/client
--      so voice calls show up in the entity timeline alongside SMS.
--
-- Schedule: every minute. Calls typically finish their RC recording
-- materialisation within ~30 seconds; running once a minute keeps the
-- average transcript lag under a minute for a back office that
-- expects "the call I just hung up on is in the notes."
--
-- pg_cron job inventory after this migration ships:
--   1. automation-cron-job          (every 30 min)
--   2. outcome-analyzer             (every 4 h)
--   3. payroll-generate-timesheets  (Mondays 13:00 UTC)
--   4. poll-bookings-appointments   (every 5 min)
--   5. service-plan-extend-ongoing  (Mondays 14:00 UTC)
--   6. post-call-processor          (every minute)   ← this one
-- (Job *number* is assigned by pg_cron, not by this list. The
-- Supabase Dashboard's Cron tab keys off the job *name*.)
--
-- Idempotency: the edge function is safe to rerun. transcript_fetched_at
-- is stamped on success, on permanent give-up (>24h), and intentionally
-- left NULL on soft failure so the next tick retries. The
-- call-transcription function caches in call_transcriptions keyed by
-- recording_id, so duplicate calls are cheap.
--
-- Rollback: see _rollback/20260512000000_post_call_processor_cron_down.sql.

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

DO $$
DECLARE
  v_job_count int;
BEGIN
  SELECT count(*) INTO v_job_count
  FROM cron.job
  WHERE jobname = 'post-call-processor';

  IF v_job_count <> 1 THEN
    RAISE EXCEPTION
      'post-call-processor cron job: expected 1 row in cron.job, found %', v_job_count;
  END IF;
END
$$;
