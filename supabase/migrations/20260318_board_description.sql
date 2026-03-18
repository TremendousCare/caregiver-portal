ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS board_description text DEFAULT NULL;
COMMENT ON COLUMN caregivers.board_description IS 'Rich text description for Kanban card (HTML string from Tiptap editor)';
