-- ═══════════════════════════════════════════════════════════════
-- Fix ai_suggestions source_type CHECK constraint
-- Add 'event_triggered' to allowed values (Phase 4B event triggers
-- write this source_type but the original constraint didn't include it)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE ai_suggestions
  DROP CONSTRAINT IF EXISTS ai_suggestions_source_type_check;

ALTER TABLE ai_suggestions
  ADD CONSTRAINT ai_suggestions_source_type_check
  CHECK (source_type IN ('inbound_sms', 'inbound_email', 'proactive', 'outcome', 'event_triggered'));
