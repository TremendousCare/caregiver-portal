-- ═══════════════════════════════════════════════════════════════
-- Executive Task Management — Phase 3, daily generation cron
--
-- Registers the `exec-tasks-generate` edge function on a daily
-- schedule (10:00 UTC = 02:00 / 03:00 Pacific). Picked the small
-- hours to land any new tasks on the dashboard before the office
-- opens. Idempotent — re-running the cron with the same active
-- templates is a no-op (every generated row is protected by the
-- partial unique indexes added in 20260528000200_exec_tables.sql).
--
-- pg_cron job inventory after this migration ships:
--   1. automation-cron-job          (every 30 min)
--   2. outcome-analyzer             (every 4h)
--   3. payroll-generate-timesheets  (Mondays 13:00 UTC)
--   4. poll-bookings-appointments   (every 5 min)
--   5. service-plan-extend-ongoing  (Mondays 14:00 UTC)
--   6. dispatch-lead-notifications  (every 5 min)
--   7. dispatch-task-notifications  (every 15 min)
--   8. exec-tasks-generate          (daily 10:00 UTC)  ← this one
-- (Job *number* is assigned by pg_cron; this list mirrors the
-- Supabase Dashboard's Cron tab which keys off the job *name*.)
--
-- Manual trigger: invoke the edge function with `{ "dry_run": true }`
-- to preview the next run without persisting; with `{ "org_id": "..." }`
-- to scope to a single tenant during testing.
-- ═══════════════════════════════════════════════════════════════

SELECT cron.schedule(
  'exec-tasks-generate',
  '0 10 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/exec-tasks-generate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('triggered_at', now()::text),
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);

-- Sanity check: confirm the job is registered. The cron schema name
-- is `cron`; `pg_get_serial_sequence` is irrelevant here. We look
-- for the job_name we just inserted.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'exec-tasks-generate'
  ) THEN
    RAISE EXCEPTION 'exec_tasks_generate_cron: job not registered after schedule()';
  END IF;
END
$$;
