-- ═══════════════════════════════════════════════════════════════
-- Split "Driver's License & Car" into two separate fields
--
-- Purpose:
--   The caregivers.has_dl column previously encoded a combined
--   "has a driver's license AND a personal vehicle" flag. The
--   caregiver team wants to track these separately because some
--   caregivers have a DL but no car and will drive the client's
--   vehicle.
--
--   This migration adds a new `has_vehicle` column and backfills
--   it from the existing `has_dl` value, per the approved rule:
--     - has_dl='yes'  → has_vehicle='yes'  (previously implied both)
--     - has_dl='no'   → has_vehicle='no'
--     - has_dl=null   → has_vehicle=null   (unknown stays unknown)
--
--   After this migration, `has_dl` semantically means "has a
--   driver's license" (not the combined flag), and `has_vehicle`
--   means "has their own vehicle available". Application code is
--   updated in the same PR.
--
-- Safety notes:
--   - Adds one nullable column. Existing code continues to read
--     has_dl exactly as before.
--   - Backfill is idempotent: running again produces the same
--     values (the new column already matches has_dl).
--   - No rows are deleted or have their existing columns modified
--     beyond the has_vehicle backfill.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE caregivers
  ADD COLUMN IF NOT EXISTS has_vehicle TEXT;

COMMENT ON COLUMN caregivers.has_vehicle IS
  'Whether the caregiver has their own vehicle. Values: ''yes'', ''no''. Null = unknown/not asked.';

-- Backfill: for every existing row, copy has_dl into has_vehicle
-- where has_vehicle has not yet been set. This matches the prior
-- combined semantic of has_dl.
UPDATE caregivers
   SET has_vehicle = has_dl
 WHERE has_vehicle IS NULL
   AND has_dl IS NOT NULL;
