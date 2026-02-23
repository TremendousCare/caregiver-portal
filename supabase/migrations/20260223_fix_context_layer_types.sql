-- ═══════════════════════════════════════════════════════════════
-- Fix: entity_id type mismatch & events CHECK constraint
-- context_memory and events used uuid for entity_id, but
-- caregivers/clients use TEXT primary keys. action_outcomes
-- already had it right (text). This migration fixes consistency.
-- Also adds 'system' to events.entity_type CHECK constraint.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. Fix context_memory.entity_id: uuid → text ──
ALTER TABLE context_memory ALTER COLUMN entity_id TYPE text USING entity_id::text;

-- ── 2. Fix events.entity_id: uuid → text ──
ALTER TABLE events ALTER COLUMN entity_id TYPE text USING entity_id::text;

-- ── 3. Add 'system' to events.entity_type CHECK constraint ──
-- Drop old constraint and create new one with 'system' included
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_entity_type_check;
ALTER TABLE events ADD CONSTRAINT events_entity_type_check
  CHECK (entity_type IN ('caregiver', 'client', 'system'));
