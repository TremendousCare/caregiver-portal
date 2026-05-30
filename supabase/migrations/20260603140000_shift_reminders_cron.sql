-- ═══════════════════════════════════════════════════════════════
-- shift-reminders — reminder_sent_at column + pg_cron job (every 15 min)
--
-- Adds a nullable dedupe column to shifts and schedules the
-- shift-reminders edge function, which pushes a Web Push reminder to each
-- assigned caregiver's subscribed devices ~1 hour before their shift.
--
-- Mirrors the quickbooks-token-refresh / automation-cron pattern: pg_cron
-- calls the edge function via net.http_post using the stored project URL +
-- publishable key from the vault.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS; the cron block
-- unschedules any prior job of the same name before (re)scheduling.
-- ═══════════════════════════════════════════════════════════════

-- 1. Dedupe column: stamped once a shift has been reminded so the job
--    never double-notifies. Nullable; old rows + non-reminded shifts stay
--    NULL. No backfill needed.
ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

-- 2. Schedule the cron.
DO $$
DECLARE
  v_project_url text;
  v_publishable_key text;
BEGIN
  SELECT decrypted_secret INTO v_project_url
  FROM vault.decrypted_secrets WHERE name = 'project_url';

  SELECT decrypted_secret INTO v_publishable_key
  FROM vault.decrypted_secrets WHERE name = 'publishable_key';

  IF v_project_url IS NULL OR v_publishable_key IS NULL THEN
    RAISE NOTICE 'Skipping shift-reminders cron scheduling: vault secrets missing.';
    RETURN;
  END IF;

  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'shift-reminders';

  PERFORM cron.schedule(
    'shift-reminders',
    '*/15 * * * *',
    format(
      $job$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{}'::jsonb
      );
      $job$,
      v_project_url || '/functions/v1/shift-reminders',
      v_publishable_key
    )
  );
END $$;
