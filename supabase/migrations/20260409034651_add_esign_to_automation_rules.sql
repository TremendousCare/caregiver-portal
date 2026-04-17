-- Add send_esign_envelope to the automation_rules action_type constraint
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_action_type_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_action_type_check
  CHECK (action_type = ANY (ARRAY[
    'send_sms', 'send_email', 'update_phase', 'complete_task',
    'add_note', 'update_field', 'send_docusign_envelope', 'send_esign_envelope'
  ]));

-- Also add survey_completed to trigger_type if not already there
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_type_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type = ANY (ARRAY[
    'new_caregiver', 'days_inactive', 'interview_scheduled', 'phase_change',
    'task_completed', 'document_uploaded', 'document_signed', 'inbound_sms',
    'new_client', 'client_phase_change', 'client_task_completed', 'survey_completed'
  ]));
