-- Rollback for 20260510120000_payroll_phase_4_pr3.sql
--
-- Manual / break-glass only. Run via psql against the dev/staging DB
-- when you need to undo Phase 4 PR #3's additive changes. NEVER run
-- against production unless production has just merged a revert of
-- PR #3 itself.

DROP INDEX IF EXISTS public.idx_timesheets_payroll_run_id;
ALTER TABLE timesheets DROP COLUMN IF EXISTS payroll_run_id;
