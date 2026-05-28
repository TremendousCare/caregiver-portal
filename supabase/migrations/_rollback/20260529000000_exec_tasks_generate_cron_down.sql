-- Rollback for exec_tasks_generate cron.
--
-- Unschedules the daily job. The edge function itself is not
-- removed — re-running the up migration will re-register the
-- schedule without redeploying. To remove the edge function,
-- delete the supabase/functions/exec-tasks-generate/ directory
-- and let the GitHub Actions deploy workflow pick it up.

SELECT cron.unschedule('exec-tasks-generate');
