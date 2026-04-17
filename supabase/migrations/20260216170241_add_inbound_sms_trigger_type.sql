
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_type_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type = ANY (ARRAY[
    'new_caregiver','days_inactive','interview_scheduled','phase_change',
    'task_completed','document_uploaded','document_signed','inbound_sms'
  ]));
