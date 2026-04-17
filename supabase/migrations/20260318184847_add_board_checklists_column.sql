-- Add board_checklists JSONB column to caregivers table
-- Stores array of checklist objects per caregiver (Kanban board feature)
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS board_checklists jsonb DEFAULT '[]'::jsonb;

-- Add comment for documentation
COMMENT ON COLUMN caregivers.board_checklists IS 'Board checklists: array of {id, name, items: [{text, checked, checkedAt, checkedBy}], createdAt, createdBy}';
