ALTER TABLE caregivers
  ADD COLUMN IF NOT EXISTS board_labels JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN caregivers.board_labels IS 'Array of board label IDs assigned to this caregiver (e.g. ["urgent", "bilingual"])';
