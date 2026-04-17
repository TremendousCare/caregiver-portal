-- ═══════════════════════════════════════════════════════════════
-- Caregiver Profile Additions — team feedback round (Apr 2026)
--
-- Purpose:
--   Add two new optional profile fields requested by the team:
--     1. `allergies`                   — free-text known allergies (e.g. pets, smoke)
--     2. `client_gender_preference`    — whether the caregiver is willing to
--                                        work with male, female, or both
--
-- Safety notes:
--   - Purely additive. Both columns are nullable with no default.
--   - Old code continues to work; existing rows are unaffected.
--   - No data backfill required.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE caregivers
  ADD COLUMN IF NOT EXISTS allergies TEXT,
  ADD COLUMN IF NOT EXISTS client_gender_preference TEXT;

COMMENT ON COLUMN caregivers.allergies IS
  'Free-text known allergies (pets, smoke, etc.). Null = unknown/not asked.';

COMMENT ON COLUMN caregivers.client_gender_preference IS
  'Whom the caregiver is willing to work with. Values: ''male'', ''female'', ''both''. Null = unknown/not asked.';
