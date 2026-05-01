-- ═══════════════════════════════════════════════════════════════
-- Bookings integration Step 4/5/6 — add interview_not_scheduled
-- to the automation_rules.trigger_type CHECK constraint.
--
-- Without this, the new "Interview Not Scheduled (Follow-Up)" rule
-- type exposed in the Automations Settings UI cannot actually be
-- saved — the CHECK constraint installed in
-- 20260425030000_shift_automation_triggers.sql rejects the value.
--
-- Pure additive vocabulary extension:
--   - Drops + recreates the constraint (CHECK constraints can't be
--     altered in place).
--   - Includes every existing value plus the new one.
--   - Idempotent: re-running drops the old constraint and adds the
--     same new constraint.
-- ═══════════════════════════════════════════════════════════════

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
    'interview_not_scheduled'
  ]));
