
-- 1. Add 'document_signed' to trigger_type CHECK constraint
ALTER TABLE public.automation_rules
  DROP CONSTRAINT automation_rules_trigger_type_check;

ALTER TABLE public.automation_rules
  ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type = ANY (ARRAY[
    'new_caregiver'::text,
    'days_inactive'::text,
    'interview_scheduled'::text,
    'phase_change'::text,
    'task_completed'::text,
    'document_uploaded'::text,
    'document_signed'::text
  ]));

-- 2. Add 'send_docusign_envelope' to action_type CHECK constraint
ALTER TABLE public.automation_rules
  DROP CONSTRAINT automation_rules_action_type_check;

ALTER TABLE public.automation_rules
  ADD CONSTRAINT automation_rules_action_type_check
  CHECK (action_type = ANY (ARRAY[
    'send_sms'::text,
    'send_email'::text,
    'update_phase'::text,
    'complete_task'::text,
    'add_note'::text,
    'update_field'::text,
    'send_docusign_envelope'::text
  ]));

-- 3. Enable Realtime on docusign_envelopes table
ALTER PUBLICATION supabase_realtime ADD TABLE docusign_envelopes;
