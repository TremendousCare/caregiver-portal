-- Rollback for 20260516020000_..._ai_suggestions_source_type_call_analyst.sql
--
-- Restores the enum to its pre-1.6.2 four-value set. WARNING: any row
-- that landed with `source_type='call_analyst'` (i.e. any call analysis
-- the agent emitted while the migration was live) will block the
-- ADD CONSTRAINT. Delete those rows first, or migrate them to
-- 'proactive', before running this rollback.

ALTER TABLE public.ai_suggestions
  DROP CONSTRAINT IF EXISTS ai_suggestions_source_type_check;

ALTER TABLE public.ai_suggestions
  ADD CONSTRAINT ai_suggestions_source_type_check
  CHECK (source_type IN (
    'inbound_sms',
    'inbound_email',
    'proactive',
    'outcome'
  ));
