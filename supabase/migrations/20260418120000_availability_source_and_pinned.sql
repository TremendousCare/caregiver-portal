-- ═══════════════════════════════════════════════════════════════
-- Caregiver Availability: survey source + pin flag
--
-- Adds two orthogonal concepts to `caregiver_availability`:
--   1. source              — provenance of the row
--                             'survey'  → imported from a survey submission
--                             'manual'  → created/edited in the app UI
--                             NULL      → legacy (pre-feature) rows
--   2. pinned              — protection flag. When true, survey imports
--                             leave the row alone.
--   3. source_response_id  — link back to the specific survey_responses
--                             row that produced this availability, for
--                             traceability across re-surveys.
--
-- Guardrail model: on survey import we delete all rows where pinned=false
-- for the caregiver, then insert fresh rows from the latest answer. Rows
-- with pinned=true are never touched by the import path. Manual edits do
-- NOT auto-pin — users explicitly click the pin icon.
--
-- All columns are nullable / have defaults so existing code keeps working.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE caregiver_availability
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_response_id UUID
    REFERENCES survey_responses(id) ON DELETE SET NULL;

-- Fast path for the survey-import delete query:
--   DELETE FROM caregiver_availability
--   WHERE caregiver_id = $1 AND pinned = false;
CREATE INDEX IF NOT EXISTS idx_availability_caregiver_pinned
  ON caregiver_availability (caregiver_id, pinned);
