-- Rollback for the ongoing-service-plan column additions.
-- Lives outside the auto-applied migrations folder; run manually via
-- psql ONLY if the feature must be reverted.
--
-- Drops the ongoing-extension columns and the supporting partial index.
-- Cron rollback is a separate script (run that one first to stop new
-- writes against last_generated_through):
--   _rollback/20260507000001_service_plan_extend_ongoing_cron_down.sql
--
-- Note: dropping `is_ongoing` will also stop the dialog from being
-- able to flag plans as ongoing, which is the intended outcome of
-- a rollback. Any shifts already materialized for ongoing plans
-- remain in place; they'll simply behave like ordinary one-shot
-- generated shifts going forward.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260507000000_service_plan_ongoing_columns_down.sql

DROP INDEX IF EXISTS public.idx_service_plans_ongoing_active;
ALTER TABLE public.service_plans DROP COLUMN IF EXISTS last_generated_through;
ALTER TABLE public.service_plans DROP COLUMN IF EXISTS is_ongoing;
