-- Rollback for Paychex integration Phase 3 cron registration.
-- Lives outside the auto-applied migrations folder; run manually via
-- psql ONLY if Phase 3 must be reverted.
--
-- Removes the pg_cron schedule for payroll-generate-timesheets. The
-- edge function deployment is reverted separately (delete via
-- Supabase Dashboard → Edge Functions, or revert the PR and re-run
-- the deploy-edge-functions workflow).
--
-- Existing draft `timesheets` rows are left in place. Phase 4's UI
-- can mark them `rejected` if the back office decides the run was
-- incorrect, or they can simply be ignored.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260426000000_payroll_generate_timesheets_cron_down.sql

SELECT cron.unschedule('payroll-generate-timesheets');
