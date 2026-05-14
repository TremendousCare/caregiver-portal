-- ═══════════════════════════════════════════════════════════════
-- interview_reminder — SMS reminder N minutes before a scheduled
-- Microsoft Bookings interview.
--
-- 1) Extends automation_rules.trigger_type CHECK to include the new
--    'interview_reminder' value so the Caregiver Automation Rules UI
--    can save rows with this trigger.
--
-- 2) Adds a dedicated 5-minute pg_cron job that calls the new
--    `interview-reminders` edge function. We do NOT extend
--    automation-cron's 30-min cadence — a 15-min reminder needs ≤5-min
--    cron precision to fire close to the intended lead time, and
--    bumping the global automation-cron to 5× the rate would re-run
--    every survey / availability / shift-reminder rule six times more
--    often than necessary. A dedicated job keeps the cadence change
--    scoped to interview reminders.
--
-- 3) Adds a functional index on automation_log for per-(rule,
--    interview, minutes_before) dedup so the cron's "have we already
--    sent this reminder?" check stays an index seek as the log table
--    grows. Mirrors the pattern from idx_automation_log_shift_reminder
--    in 20260425030000.
--
-- Production safety:
--   - CHECK constraint drop+recreate is the same pattern as
--     20260505020000_bookings_step6_interview_not_scheduled_trigger_type.
--   - Index is CREATE IF NOT EXISTS so re-runs are idempotent.
--   - cron.schedule is wrapped in a guard that unschedules the prior
--     job if it exists (idempotent re-run).
--   - No tables created, no columns added, no rows updated/deleted.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Extend the trigger_type CHECK to allow 'interview_reminder' ──
ALTER TABLE automation_rules
  DROP CONSTRAINT IF EXISTS automation_rules_trigger_type_check;

ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type = ANY (ARRAY[
    'new_caregiver',
    'days_inactive',
    'interview_scheduled',
    'phase_change',
    'task_completed',
    'document_uploaded',
    'document_signed',
    'inbound_sms',
    'new_client',
    'client_phase_change',
    'client_task_completed',
    'survey_completed',
    'survey_pending',
    'recurring_availability_check',
    'shift_assigned',
    'shift_reminder_24h',
    'shift_changed',
    'shift_canceled',
    'interview_not_scheduled',
    'interview_reminder'
  ]));

-- ── 2. Index for interview-reminder dedup ──
-- The cron queries automation_log WHERE rule_id = ? AND status = 'success'
-- AND trigger_context->>'interview_id' = ? AND trigger_context->>'minutes_before' = ?
-- to detect "did we already send this lead-time reminder for this
-- specific interview row?". Partial index keeps it small.
CREATE INDEX IF NOT EXISTS idx_automation_log_interview_reminder
  ON automation_log (
    rule_id,
    ((trigger_context ->> 'interview_id')),
    ((trigger_context ->> 'minutes_before'))
  )
  WHERE status = 'success'
    AND trigger_context ->> 'interview_id' IS NOT NULL;

-- ── 3. Schedule the 5-minute interview-reminders cron ──
-- Cadence rationale: a 15-min reminder needs cron precision ≤ the lead
-- time, with a 5-min window so a tick reliably catches every interview
-- exactly once. 5-min cadence + 5-min window = at most one tick can
-- match per (interview, minutes_before) → exactly-once semantics with
-- the automation_log dedup as a belt-and-suspenders backstop.
--
-- Wrapped in a DO block that unschedules any prior job with the same
-- name so this migration is safely re-runnable.
DO $$
BEGIN
  PERFORM cron.unschedule('interview-reminders')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'interview-reminders'
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'interview-reminders',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1)
           || '/functions/v1/interview-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key' LIMIT 1)
    ),
    body := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);
