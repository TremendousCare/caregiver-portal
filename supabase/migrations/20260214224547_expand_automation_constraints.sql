-- Expand trigger_type to include new triggers
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_type_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type = ANY (ARRAY[
    'new_caregiver','days_inactive','interview_scheduled',
    'phase_change','task_completed','document_uploaded'
  ]));

-- Expand action_type to include new actions
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_action_type_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_action_type_check
  CHECK (action_type = ANY (ARRAY[
    'send_sms','send_email',
    'update_phase','complete_task','add_note','update_field'
  ]));
