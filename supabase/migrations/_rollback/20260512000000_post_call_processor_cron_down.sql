-- Rollback for 20260512000000_post_call_processor_cron.sql
-- Lives outside the auto-applied migrations folder; run manually via
-- psql ONLY if the feature must be reverted.
--
-- Unschedules the post-call-processor cron job. The post-call-processor
-- edge function is left in place — without the cron trigger it simply
-- never runs. Drop the edge function from supabase/functions/ in a
-- separate revert if you want it gone entirely.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260512000000_post_call_processor_cron_down.sql

SELECT cron.unschedule('post-call-processor')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'post-call-processor'
);
