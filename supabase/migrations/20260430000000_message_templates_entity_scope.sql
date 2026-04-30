-- ═══════════════════════════════════════════════════════════════
-- Message Templates — entity_scope column
--
-- Templates were originally caregiver-only. Adding a client Messages
-- tab requires the picker to filter by audience. This column captures
-- which entity type a template applies to:
--
--   NULL       — applies to both (default for existing rows)
--   'caregiver' — only shows in caregiver SMS composer
--   'client'    — only shows in client SMS composer
--
-- Existing rows stay NULL so they continue to show up in the caregiver
-- picker exactly as before, and start showing in the new client picker
-- automatically. Admins can scope new templates explicitly.
--
-- Idempotent (`IF NOT EXISTS`) and additive — safe to re-run.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS entity_scope TEXT
    CHECK (entity_scope IS NULL OR entity_scope IN ('caregiver', 'client'));

CREATE INDEX IF NOT EXISTS message_templates_entity_scope_idx
  ON message_templates (entity_scope)
  WHERE is_archived = false;
