-- ═══════════════════════════════════════════════════════════════
-- clock_events — audit columns for office-staff manual edits
--
-- The caregiver portal writes clock_events on every clock in / out
-- via the caregiver-clock edge function. Office staff need to be
-- able to:
--   1. Correct a wrong clock time (caregiver clocked in late, etc.)
--   2. Insert a missing clock event (caregiver forgot to clock in)
--
-- We don't want to lose the original auto-recorded time when staff
-- edit a row, or to lose the GPS / geofence audit trail. So instead
-- of mutating occurred_at in place, an edit:
--   - copies the current occurred_at to original_occurred_at (only
--     on the first edit, so the very first auto-recorded value is
--     preserved through any number of subsequent edits)
--   - overwrites occurred_at with the new value
--   - stamps edited_at, edited_by, edit_reason
--
-- Manual inserts (forgotten punches) set source='manual_entry' and
-- have NULL geofence fields (no GPS to evaluate).
--
-- All columns are nullable / additive. Old code (the edge function,
-- the caregiver portal) continues to work unchanged.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE clock_events
  ADD COLUMN IF NOT EXISTS source                 text DEFAULT 'caregiver_app',
  ADD COLUMN IF NOT EXISTS edited_at              timestamptz,
  ADD COLUMN IF NOT EXISTS edited_by              text,
  ADD COLUMN IF NOT EXISTS edit_reason            text,
  ADD COLUMN IF NOT EXISTS original_occurred_at   timestamptz;

-- source values:
--   'caregiver_app'  — written by caregiver-clock edge function (default)
--   'manual_entry'   — inserted by office staff for a missing punch
ALTER TABLE clock_events
  DROP CONSTRAINT IF EXISTS clock_events_source_check;
ALTER TABLE clock_events
  ADD CONSTRAINT clock_events_source_check
  CHECK (source IN ('caregiver_app', 'manual_entry'));

-- Backfill source on existing rows so the constraint holds and so
-- the UI can reliably distinguish auto-recorded events from manual
-- ones. Every pre-existing row came from the edge function.
UPDATE clock_events
   SET source = 'caregiver_app'
 WHERE source IS NULL;
