-- Rollback for Paychex Phase 4 PR #1 (backend foundation).
-- Reverses 20260428000000_payroll_phase_4_pr1.sql.
--
-- Run manually via psql ONLY if Phase 4 PR #1 must be reverted:
--   psql "$SUPABASE_DB_URL" \
--     -f supabase/migrations/_rollback/20260428000000_payroll_phase_4_pr1_down.sql
--
-- Data loss warning: any `paychex_employee_id` values populated by
-- the Phase 4 PR #1 backfill function will be DROPped with the
-- column. They can be repopulated by re-running the backfill once
-- the column is recreated.

BEGIN;

-- Strip the pay_components key from TC's payroll settings without
-- disturbing other keys (mileage_rate, ot_jurisdiction, timezone, etc.).
UPDATE public.organizations
SET settings = settings
  || jsonb_build_object(
       'payroll',
       COALESCE(settings -> 'payroll', '{}'::jsonb) - 'pay_components'
     ),
    updated_at = now()
WHERE slug = 'tremendous-care';

DROP INDEX IF EXISTS public.idx_caregivers_paychex_employee_id;

ALTER TABLE public.caregivers DROP COLUMN IF EXISTS paychex_employee_id;

COMMIT;
