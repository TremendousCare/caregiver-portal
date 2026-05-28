-- Rollback for exec_task_notifications_dispatch cron.
--
-- Unschedules the job. The edge function source stays in the repo;
-- re-running the up migration re-registers the schedule without
-- redeploying.

SELECT cron.unschedule('dispatch-exec-task-notifications');
