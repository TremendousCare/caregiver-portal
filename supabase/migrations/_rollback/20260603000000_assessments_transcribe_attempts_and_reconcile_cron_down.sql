-- Rollback for 20260603000000_assessments_transcribe_attempts_and_reconcile_cron.sql
--
-- Unschedules the reconcile cron and drops the two bookkeeping columns.
-- Safe to run before any transcription has occurred. Dropping the
-- columns is destructive to that bookkeeping data only; the audio,
-- transcripts, and assessment rows are untouched.

DO $$
BEGIN
  PERFORM cron.unschedule('assessment-transcribe-reconcile')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'assessment-transcribe-reconcile'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

ALTER TABLE public.assessments DROP COLUMN IF EXISTS dg_request_id;
ALTER TABLE public.assessments DROP COLUMN IF EXISTS transcribe_attempts;
