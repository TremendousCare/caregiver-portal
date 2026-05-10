-- Phase 1.1.B — daily agent_actions chain verifier cron.
--
-- Calls /functions/v1/agent-actions-verify once a day at 13:30 UTC
-- (~6:30 AM Pacific). The edge function reads every agent_actions
-- row for the default org, recomputes the hash chain, verifies each
-- signature, and writes a `events` row with
-- event_type='agent_actions_chain_break' if anything fails.
--
-- Why daily not every-N-minutes: the hash chain is append-only;
-- breaks would be caused by either (a) direct DB tampering on a
-- write-locked-down table — which requires postgres or service_role
-- access already, a much larger compromise than the verifier is
-- meant to catch — or (b) a bug in the writer. Daily is plenty for
-- (b). We can tighten to hourly if (a) becomes a real concern.
--
-- Schedule: 13:30 UTC = 6:30 AM Pacific. Runs after the planner
-- (14:00 UTC) and the payroll batch (13:00 UTC Mondays), but before
-- any human ops would notice an alert. Lands the chain-break event
-- in the events table where the AI Suggestions panel will surface
-- it on Monday morning.
--
-- pg_cron job inventory after this migration ships:
--   1. automation-cron-job          (every 30 min)
--   2. outcome-analyzer             (every 4h)
--   3. payroll-generate-timesheets  (Mondays 13:00 UTC)
--   4. poll-bookings-appointments   (every 5 min)
--   5. service-plan-extend-ongoing  (Mondays 14:00 UTC)
--   6. agent-actions-verify         (daily 13:30 UTC)  ← this one

SELECT cron.schedule(
  'agent-actions-verify',
  '30 13 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/agent-actions-verify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('triggered_at', now()::text),
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);
