-- Paychex integration Phase 1: caregiver columns.
--
-- Additive nullable columns on `caregivers` to support Paychex worker
-- sync (Phase 2) and the Phase 6 Paychex-hosted W-4/I-9/direct-deposit
-- onboarding flow. The columns are added all at once so future phases
-- can ship without further migrations to this table.
--
-- All columns are nullable. Existing rows continue to work unchanged.
--
-- See: docs/plans/2026-04-25-paychex-integration-plan.md (Phase 1 — Data model).

-- Paychex worker identity + sync state. Populated by the Phase 2
-- paychex-sync-worker edge function on first successful POST.
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS paychex_worker_id text;
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS paychex_sync_status text DEFAULT 'not_started';
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS paychex_last_synced_at timestamptz;
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS paychex_sync_error text;

-- Phase 6 onboarding completion timestamps. Populated by webhook
-- handler when Paychex notifies that the caregiver completed each
-- onboarding step in their hosted flow. The actual W-4 elections,
-- I-9 documents, and bank details live in Paychex — never here.
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS w4_completed_at timestamptz;
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS i9_completed_at timestamptz;
ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS direct_deposit_completed_at timestamptz;

-- Constrains the values written to paychex_sync_status without
-- breaking existing rows (NULL stays valid until backfilled, which
-- isn't planned for v1 — caregivers without Paychex sync stay NULL).
-- Drop-then-add for re-runnability, matching the project pattern in
-- 20260425000000_clock_events_audit_columns.sql.
ALTER TABLE caregivers
  DROP CONSTRAINT IF EXISTS caregivers_paychex_sync_status_check;
ALTER TABLE caregivers
  ADD CONSTRAINT caregivers_paychex_sync_status_check
  CHECK (paychex_sync_status IS NULL OR paychex_sync_status IN (
    'not_started', 'pending', 'active', 'error', 'rehire_blocked', 'terminated'
  ));

-- Index for the Phase 2 sync function which looks up by paychex_worker_id
-- when receiving webhook events back from Paychex (Phase 5/6).
-- Partial index: most caregivers will never have a paychex_worker_id.
CREATE INDEX IF NOT EXISTS idx_caregivers_paychex_worker_id
  ON caregivers (paychex_worker_id)
  WHERE paychex_worker_id IS NOT NULL;

-- Index for the Phase 4 ThisWeekView exception detection: which
-- caregivers in the org have unfinished or errored Paychex sync?
CREATE INDEX IF NOT EXISTS idx_caregivers_paychex_sync_status
  ON caregivers (paychex_sync_status)
  WHERE paychex_sync_status IN ('pending', 'error', 'rehire_blocked');
