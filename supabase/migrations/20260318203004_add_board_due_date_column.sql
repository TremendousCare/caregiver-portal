-- Add board_due_date column to caregivers table
-- Stores an optional due date for the card (ISO date string, e.g. "2026-03-25")
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS board_due_date text DEFAULT NULL;

COMMENT ON COLUMN caregivers.board_due_date IS 'Optional due date for Kanban card (ISO date string YYYY-MM-DD)';
