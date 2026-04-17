-- Add 'survey_pending' to the automation_rules.trigger_type CHECK constraint.
--
-- The 20260415 migration added reminder-tracking columns to survey_responses
-- and the automation-cron now processes survey_pending rules, but the CHECK
-- constraint was never widened in that migration — so creating a rule with
-- trigger_type = 'survey_pending' via the frontend/SQL fails with a check
-- violation.
--
-- This migration reconciles git with the production DB (where the constraint
-- was patched ad-hoc) and makes fresh environments consistent.

ALTER TABLE automation_rules DROP CONSTRAINT IF EXISTS automation_rules_trigger_type_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type = ANY (ARRAY[
    'new_caregiver', 'days_inactive', 'interview_scheduled', 'phase_change',
    'task_completed', 'document_uploaded', 'document_signed', 'inbound_sms',
    'new_client', 'client_phase_change', 'client_task_completed',
    'survey_completed', 'survey_pending'
  ]));
