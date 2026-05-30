-- ═══════════════════════════════════════════════════════════════
-- clock_events.source — allow 'offline_sync'
--
-- The caregiver PWA can now queue a clock-in / clock-out while offline
-- and flush it to the caregiver-clock edge function when connectivity
-- returns. Those late-synced rows are tagged source='offline_sync' so
-- office staff reviewing the audit log can tell a live tap from one that
-- was recorded in the field and synced afterward.
--
-- This widens the existing CHECK constraint to accept the new value.
-- Purely additive: existing rows ('caregiver_app', 'manual_entry') stay
-- valid, old code paths are unaffected, and the statement is idempotent
-- (DROP IF EXISTS + ADD), so it is safe to re-run via the migrations
-- workflow (`supabase db push --include-all`).
--
-- source values after this migration:
--   'caregiver_app'  — written live by the caregiver-clock edge function
--   'offline_sync'   — queued offline by the PWA, synced later (real tap
--                      time preserved in occurred_at)
--   'manual_entry'   — inserted by office staff for a missing punch
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE clock_events
  DROP CONSTRAINT IF EXISTS clock_events_source_check;

ALTER TABLE clock_events
  ADD CONSTRAINT clock_events_source_check
  CHECK (source IN ('caregiver_app', 'offline_sync', 'manual_entry'));
