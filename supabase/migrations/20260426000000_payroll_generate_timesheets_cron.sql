-- Paychex integration Phase 3: schedule the weekly timesheet
-- generation cron.
--
-- The edge function `payroll-generate-timesheets` (Phase 3) iterates
-- organizations with `settings.features_enabled.payroll = true` and,
-- for each, generates draft `timesheets` + `timesheet_shifts` rows
-- for the most recently completed Mon→Sun workweek.
--
-- Schedule: every Monday at 13:00 UTC.
--   - During Pacific Daylight Time (~Mar–Nov) this is 06:00 PT.
--   - During Pacific Standard Time (~Nov–Mar) this is 05:00 PT.
-- Either way the prior Mon→Sun workweek has finished, so the cron
-- always operates on completed data. The plan calls for "Monday
-- 6 AM Pacific"; pg_cron schedules in UTC, so we pick the closest
-- year-round approximation and accept a 1h drift across DST.
--
-- Idempotency: the edge function checks for existing timesheets at
-- (org_id, caregiver_id, pay_period_start) before inserting. The
-- DB-level UNIQUE constraint on the same tuple is the second line of
-- defense. Re-running the cron (or invoking it manually from the
-- Supabase Dashboard for backfill) is safe.
--
-- Per CLAUDE.md ("pg_cron jobs"), this is the project's third pg_cron
-- job. Existing jobs:
--   1. automation-cron-job          (every 30 min)
--   2. daily-ai-planner             (daily 14:00 UTC)
--   3. payroll-generate-timesheets  (weekly Monday 13:00 UTC)  ← this one
--
-- Note: the project also has historical cron jobs registered by
-- earlier migrations (outcome-analyzer, route-webhook-subscriptions,
-- etc.). Job *number* is assigned by pg_cron; the plan's references
-- to "job 1 / job 2" are loose. The job name (`payroll-generate-timesheets`)
-- is what the Supabase Dashboard's Cron tab uses.

SELECT cron.schedule(
  'payroll-generate-timesheets',
  '0 13 * * 1',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/payroll-generate-timesheets',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('triggered_at', now()::text),
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);
