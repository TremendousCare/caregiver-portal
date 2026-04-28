-- Paychex integration Phase 4 PR #1: backend foundation for the
-- Approval UI + CSV export.
--
-- Two additive changes:
--
-- 1) `caregivers.paychex_employee_id text` (nullable) — Paychex's SHORT
--    per-company employee number (e.g. "54", "67"), distinct from the
--    long alphanumeric `paychex_worker_id` we already store. The Paychex
--    Flex SPI ("Hours Only Flexible") import format requires this short
--    integer in its "Worker ID" column. Phase 4's CSV export is the
--    first consumer.
--
--    Backfilled out-of-band by the Phase 4 PR #1 edge function
--    `paychex-backfill-employee-ids`, which calls
--    `GET /companies/{companyId}/workers` and matches on
--    `workerCorrelationId` (= caregivers.id, set by Phase 2's mapping).
--    Stays nullable indefinitely: caregivers who haven't been synced to
--    Paychex have no employeeId yet; the exception
--    `caregiver_missing_paychex_employee_id` blocks their inclusion in
--    a CSV until backfill catches them.
--
-- 2) Seed `organizations.settings.payroll.pay_components` for the
--    Tremendous Care row. The four keys map our hour categories to
--    TC's Paychex Flex Earnings names (case-sensitive — must match
--    the Earning configured in Paychex Flex Settings → Earnings).
--    Owner-confirmed values 2026-04-27:
--      regular     = "Hourly"
--      overtime    = "Overtime"
--      double_time = null  (not yet configured in TC's Paychex; the
--                          engine produces DT hours rarely; the new
--                          `dt_pay_component_missing` exception blocks
--                          export until owner adds the Earning OR
--                          zeroes the DT hours via inline edit.)
--      mileage     = "Mileage"
--
--    Phase 4 PR #3 will add a Settings UI to update these without a
--    redeploy. Until then, edits go via SQL.
--
-- Both changes are idempotent: ADD COLUMN IF NOT EXISTS, jsonb merge.
-- Re-running the migration is safe.
--
-- Plan reference:
--   docs/plans/2026-04-25-paychex-integration-plan.md
--   docs/handoff-paychex-phase-4.md  ("Phase 4 PR #1")

ALTER TABLE caregivers ADD COLUMN IF NOT EXISTS paychex_employee_id text;

-- Partial unique index — within an org's Paychex company, each
-- short employeeId is unique. Until Phase B adds caregivers.org_id,
-- TC is the only org so a global partial index serves the same purpose
-- and prevents accidental duplicates from the backfill.
CREATE UNIQUE INDEX IF NOT EXISTS idx_caregivers_paychex_employee_id
  ON caregivers (paychex_employee_id)
  WHERE paychex_employee_id IS NOT NULL;

-- Append pay_components into the existing payroll object in TC's
-- settings. COALESCE protects against the (theoretically impossible)
-- case of a missing payroll key — the Phase 1 seed migration has
-- already written it, but defensive merge keeps the migration safe to
-- re-run after a partial rollback.
UPDATE public.organizations
SET settings = settings
  || jsonb_build_object(
       'payroll',
       COALESCE(settings -> 'payroll', '{}'::jsonb)
         || jsonb_build_object(
              'pay_components', jsonb_build_object(
                'regular',     'Hourly',
                'overtime',    'Overtime',
                'double_time', null,
                'mileage',     'Mileage'
              )
            )
     ),
    updated_at = now()
WHERE slug = 'tremendous-care';
