-- Rollback for the ongoing-service-plan cron registration.
-- Lives outside the auto-applied migrations folder; run manually via
-- psql ONLY if the feature must be reverted.
--
-- Removes the pg_cron schedule for service-plan-extend-ongoing. The
-- edge function deployment is reverted separately (delete via
-- Supabase Dashboard → Edge Functions, or revert the PR and re-run
-- the deploy-edge-functions workflow).
--
-- Run this BEFORE the column rollback (20260507000000_..._down.sql)
-- so no new writes hit `last_generated_through` while the column is
-- being dropped.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260507000001_service_plan_extend_ongoing_cron_down.sql

SELECT cron.unschedule('service-plan-extend-ongoing');
