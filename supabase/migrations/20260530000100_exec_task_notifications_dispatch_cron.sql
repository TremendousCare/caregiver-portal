-- ═══════════════════════════════════════════════════════════════
-- Executive Task Notifications — cron schedule
--
-- Registers dispatch-exec-task-notifications on a 15-minute cadence.
-- Mirrors the dispatch-task-notifications cron (Phase 2 of follow-up
-- tasks) — slow enough to not flood notifications_user, fast enough
-- that "due now" actually feels timely.
--
-- pg_cron job inventory after this migration ships:
--    1. automation-cron-job                  (every 30 min)
--    2. outcome-analyzer                     (every 4h)
--    3. payroll-generate-timesheets          (Mondays 13:00 UTC)
--    4. poll-bookings-appointments           (every 5 min)
--    5. service-plan-extend-ongoing          (Mondays 14:00 UTC)
--    6. dispatch-lead-notifications          (every 5 min)
--    7. dispatch-task-notifications          (every 5 min)
--    8. exec-tasks-generate                  (daily 10:00 UTC)
--    9. dispatch-exec-task-notifications     (every 15 min)  ← this one
--
-- Idempotent: cron.schedule overwrites by job name.
-- ═══════════════════════════════════════════════════════════════

SELECT cron.schedule(
  'dispatch-exec-task-notifications',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/dispatch-exec-task-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('triggered_at', now()::text),
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'dispatch-exec-task-notifications'
  ) THEN
    RAISE EXCEPTION
      'exec_task_notifications_dispatch_cron: job not registered after schedule()';
  END IF;
END
$$;
