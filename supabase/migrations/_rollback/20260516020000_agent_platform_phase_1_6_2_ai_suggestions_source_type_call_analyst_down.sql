-- Rollback for 20260516020000_..._ai_suggestions_source_type_call_analyst.sql
--
-- Restores the enum to its pre-1.6.2 FIVE-value set
-- (inbound_sms, inbound_email, proactive, outcome, event_triggered) —
-- the state established by migration 20260321220555_fix_source_type_
-- constraint.sql, not the original four-value set from
-- 20260311200407.
--
-- WARNING: any row that landed with `source_type='call_analyst'` (i.e.
-- any call analysis the agent emitted while the migration was live)
-- will block the ADD CONSTRAINT. Delete those rows first, or migrate
-- them to 'proactive', before running this rollback.

ALTER TABLE public.ai_suggestions
  DROP CONSTRAINT IF EXISTS ai_suggestions_source_type_check;

ALTER TABLE public.ai_suggestions
  ADD CONSTRAINT ai_suggestions_source_type_check
  CHECK (source_type IN (
    'inbound_sms',
    'inbound_email',
    'proactive',
    'outcome',
    'event_triggered'
  ));
