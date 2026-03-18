-- Add board_labels column to caregivers table
-- Stores array of label IDs assigned to each caregiver for the Kanban board
-- Nullable, defaults to empty array, purely additive (no existing data affected)
ALTER TABLE caregivers
  ADD COLUMN IF NOT EXISTS board_labels JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN caregivers.board_labels IS 'Array of board label IDs assigned to this caregiver (e.g. ["urgent", "bilingual"])';
