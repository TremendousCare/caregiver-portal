-- Add trigger_context column to automation_log for context-aware dedup
ALTER TABLE automation_log ADD COLUMN trigger_context jsonb DEFAULT '{}'::jsonb;
