
-- Expand trigger_type CHECK to include client triggers
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_type_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type = ANY (ARRAY[
    'new_caregiver'::text, 'days_inactive'::text, 'interview_scheduled'::text,
    'phase_change'::text, 'task_completed'::text, 'document_uploaded'::text,
    'document_signed'::text, 'inbound_sms'::text,
    'new_client'::text, 'client_phase_change'::text, 'client_task_completed'::text
  ]));
