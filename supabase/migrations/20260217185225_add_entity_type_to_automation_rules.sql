
-- Add entity_type column to automation_rules for client vs caregiver distinction
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS entity_type TEXT DEFAULT 'caregiver';

-- Index for filtering by entity type
CREATE INDEX IF NOT EXISTS idx_automation_rules_entity ON automation_rules(entity_type);
