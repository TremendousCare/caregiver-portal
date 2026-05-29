-- ─────────────────────────────────────────────────────────────────
-- Assessment transcription engine — bookkeeping columns + reconcile cron
-- (PR 2 of the in-home assessment transcription feature)
--
-- Additive only. Adds two nullable/defaulted columns the Deepgram
-- pipeline writes, and schedules the safety-net reconciliation cron.
--
--   - assessments.transcribe_attempts : how many times we've submitted
--     this assessment to Deepgram. Reconciler caps retries on it.
--   - assessments.dg_request_id       : last Deepgram request_id, for
--     observability / correlation with Deepgram's dashboard.
--
-- Cron `assessment-transcribe-reconcile` (every 5 min) invokes the edge
-- function of the same name, which recovers assessments stuck mid-flight
-- (lost initial submit, lost callback) and gives up after maxAttempts.
-- Mirrors the post-call-processor cron pattern (20260512000000).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; cron.unschedule-then-schedule;
-- safe to re-run under the Deploy Database Migrations workflow.
--
-- Rollback: _rollback/20260603000000_assessments_transcribe_attempts_and_reconcile_cron_down.sql
-- ─────────────────────────────────────────────────────────────────

-- ── 1. Bookkeeping columns ────────────────────────────────────────
ALTER TABLE public.assessments
  ADD COLUMN IF NOT EXISTS transcribe_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE public.assessments
  ADD COLUMN IF NOT EXISTS dg_request_id text;

-- ── 2. Reconciliation cron ────────────────────────────────────────
-- pg_cron job inventory after this migration ships (names, not numbers):
--   automation-cron, outcome-analyzer, payroll-generate-timesheets,
--   poll-bookings-appointments, service-plan-extend-ongoing,
--   post-call-processor, exec-tasks-generate, dispatch-lead-notifications,
--   assessment-transcribe-reconcile  ← this one (every 5 min)

-- Guarded unschedule so re-running this migration is safe. The
-- EXCEPTION swallow mirrors dispatch-lead-notifications: pg_cron's
-- unschedule occasionally races with itself on fresh projects.
DO $$
BEGIN
  PERFORM cron.unschedule('assessment-transcribe-reconcile')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'assessment-transcribe-reconcile'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'assessment-transcribe-reconcile',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/assessment-transcribe-reconcile',
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
  WHERE jobname = 'assessment-transcribe-reconcile';

  IF v_job_count <> 1 THEN
    RAISE EXCEPTION
      'assessment-transcribe-reconcile cron job: expected 1 row in cron.job, found %', v_job_count;
  END IF;
END
$$;
