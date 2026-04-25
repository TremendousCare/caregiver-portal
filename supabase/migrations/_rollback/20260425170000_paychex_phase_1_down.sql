-- Rollback script for Paychex integration Phase 1 (data model).
-- Lives outside the auto-applied migrations folder; run manually via
-- psql ONLY if Phase 1 must be reverted.
--
-- Reverses, in dependency-safe order:
--   - 20260425170005_seed_tc_payroll_settings.sql
--   - 20260425170004_create_paychex_api_log.sql
--   - 20260425170003_create_payroll_runs.sql
--   - 20260425170002_create_timesheet_shifts.sql
--   - 20260425170001_create_timesheets.sql
--   - 20260425170000_payroll_caregiver_columns.sql
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260425170000_paychex_phase_1_down.sql
--
-- After running:
--   - Re-enable the Phase 0 paychex-diagnostic edge function only
--     if you also need to re-discover the companyId. Otherwise leave
--     it deleted; the discovered values are documented in the plan.
--   - The PAYCHEX_DIAGNOSTIC_TOKEN Edge Function secret can stay set
--     or be removed; nothing reads it once the diagnostic is gone.
--
-- Data loss warning: any timesheets, payroll_runs, timesheet_shifts,
-- and paychex_api_log rows that exist when this runs will be DROPped
-- with the tables. If TC has run any production payroll cycles by
-- the time you're considering rollback, archive those tables first.

BEGIN;

-- Strip TC's payroll settings keys without disturbing anything else
-- in organizations.settings.
UPDATE public.organizations
SET settings = (settings - 'paychex' - 'payroll')
  || jsonb_build_object(
       'features_enabled',
       COALESCE(settings -> 'features_enabled', '{}'::jsonb) - 'payroll'
     ),
    updated_at = now()
WHERE slug = 'tremendous-care';

DROP TABLE IF EXISTS public.paychex_api_log;
DROP TABLE IF EXISTS public.payroll_runs;
DROP TABLE IF EXISTS public.timesheet_shifts;
DROP TABLE IF EXISTS public.timesheets;

ALTER TABLE public.caregivers
  DROP CONSTRAINT IF EXISTS caregivers_paychex_sync_status_check;

DROP INDEX IF EXISTS public.idx_caregivers_paychex_worker_id;
DROP INDEX IF EXISTS public.idx_caregivers_paychex_sync_status;

ALTER TABLE public.caregivers DROP COLUMN IF EXISTS paychex_worker_id;
ALTER TABLE public.caregivers DROP COLUMN IF EXISTS paychex_sync_status;
ALTER TABLE public.caregivers DROP COLUMN IF EXISTS paychex_last_synced_at;
ALTER TABLE public.caregivers DROP COLUMN IF EXISTS paychex_sync_error;
ALTER TABLE public.caregivers DROP COLUMN IF EXISTS w4_completed_at;
ALTER TABLE public.caregivers DROP COLUMN IF EXISTS i9_completed_at;
ALTER TABLE public.caregivers DROP COLUMN IF EXISTS direct_deposit_completed_at;

COMMIT;
