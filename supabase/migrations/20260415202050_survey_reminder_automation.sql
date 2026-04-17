-- Survey Reminder Automation Support
-- Adds per-response reminder tracking so the `survey_pending` automation
-- trigger can safely send daily reminders up to a configurable cap and so
-- individual caregivers can be opted out without disabling the whole rule.
--
-- All columns are additive with safe defaults. Old code paths that read
-- survey_responses without these columns continue to work unchanged.

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS reminders_sent int NOT NULL DEFAULT 0;

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS last_reminder_sent_at timestamptz;

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS reminders_stopped boolean NOT NULL DEFAULT false;

-- Partial index to make the reminder cron's lookup fast without scanning
-- the full survey_responses table. Only indexes the rows the cron cares
-- about (pending + not stopped). now() is intentionally NOT used in the
-- predicate because it is not IMMUTABLE.
CREATE INDEX IF NOT EXISTS idx_survey_responses_pending_reminders
  ON survey_responses (last_reminder_sent_at, reminders_sent)
  WHERE status = 'pending' AND reminders_stopped = false;
