-- ═══════════════════════════════════════════════════════════════
-- Add `recurring_availability_check` to automation_rules trigger_type
--
-- The automation_rules.trigger_type column has a CHECK constraint that
-- enumerates the allowed trigger types. Before the recurring
-- availability check-in feature (PR 4), admins creating a rule with
-- this new trigger type would hit the constraint and see a Postgres
-- error. This migration relaxes the constraint to include the new
-- value so rule creation succeeds.
--
-- Idempotent: DROP IF EXISTS + ADD with the full enumeration, so the
-- migration can run against any prior state of the constraint.
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
    'recurring_availability_check'
  ]));
