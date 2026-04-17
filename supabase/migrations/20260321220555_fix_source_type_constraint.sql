ALTER TABLE ai_suggestions
  DROP CONSTRAINT IF EXISTS ai_suggestions_source_type_check;

ALTER TABLE ai_suggestions
  ADD CONSTRAINT ai_suggestions_source_type_check
  CHECK (source_type IN ('inbound_sms', 'inbound_email', 'proactive', 'outcome', 'event_triggered'));
