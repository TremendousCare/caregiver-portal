-- Schedule the weekly extension cron for ongoing service plans.
--
-- The edge function `service-plan-extend-ongoing` walks every plan
-- with `is_ongoing = true` and `status = 'active'`, expanding the
-- recurrence pattern forward enough that ~12 weeks of shifts are
-- always materialized. For plans that already have plenty of runway
-- the function is a no-op.
--
-- Schedule: Monday 14:00 UTC. Lands one hour after the payroll
-- timesheet cron (Monday 13:00 UTC) so the extension runs against a
-- system that just finished its payroll batch. Either run is
-- independently safe, but staggering keeps Postgres / Edge load low.
--
-- pg_cron job inventory after this migration ships:
--   1. automation-cron-job          (every 30 min)
--   2. outcome-analyzer             (every 4h)
--   3. payroll-generate-timesheets  (Mondays 13:00 UTC)
--   4. poll-bookings-appointments   (every 5 min)
--   5. service-plan-extend-ongoing  (Mondays 14:00 UTC)  ← this one
-- (Job *number* is assigned by pg_cron, not by this list. The
-- Supabase Dashboard's Cron tab keys off the job *name*.)
--
-- Idempotency: edge function dedupes against existing shifts and
-- only advances `last_generated_through` after a successful insert.
-- Re-running the cron — or invoking it manually with a body of
-- `{ "dry_run": true }` to preview — is safe.

SELECT cron.schedule(
  'service-plan-extend-ongoing',
  '0 14 * * 1',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/service-plan-extend-ongoing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('triggered_at', now()::text),
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);
