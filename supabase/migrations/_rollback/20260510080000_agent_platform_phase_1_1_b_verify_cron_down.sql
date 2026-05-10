-- Rollback for the daily agent_actions verifier cron.
-- Removes the schedule. The edge function itself stays callable
-- manually until 1.1.B is wholesale reverted.

SELECT cron.unschedule('agent-actions-verify');
