-- Paychex integration Phase 4 PR #3: payroll-runs UI + mark-as-paid +
-- settings UI.
--
-- One additive change:
--
-- 1) `timesheets.payroll_run_id uuid REFERENCES payroll_runs(id) ON
--    DELETE SET NULL`. When a payroll-export-run batches a list of
--    approved timesheets, each member timesheet gets stamped with the
--    run's id. The Phase 4 PR #3 PayrollRunsView reads this column to
--    list a run's member timesheets cheaply (no fuzzy join on
--    pay_period_start + status); Mark-as-Paid uses it to know exactly
--    which timesheets to flip when a run is marked completed.
--
--    Pre-existing `exported`-status timesheets (anything exported via
--    PR #2 before this column existed) keep `payroll_run_id = NULL`.
--    The runs view tolerates that — a run shows its member count from
--    `payroll_runs.timesheet_count` (already populated at export
--    time); the per-row drill-in only renders timesheets where the
--    column matches. Mark-as-Paid on a legacy run flips the run row
--    to `completed` but cannot flip member timesheets to `paid`
--    (because we don't know which ones); the run still serves as the
--    audit anchor.
--
-- All changes are idempotent. Re-running the migration is safe.
--
-- Plan reference:
--   docs/plans/2026-04-25-paychex-integration-plan.md
--   docs/handoff-paychex-phase-4.md  ("PR #3 — Payroll Runs view + ...")

ALTER TABLE timesheets
  ADD COLUMN IF NOT EXISTS payroll_run_id uuid
    REFERENCES payroll_runs(id) ON DELETE SET NULL;

-- Index supports the runs-detail SELECT (every run lists its member
-- timesheets). Partial index: only rows that have a run_id occupy
-- space, which is most exported/paid rows but skips the much larger
-- set of draft / pending_approval / blocked rows.
CREATE INDEX IF NOT EXISTS idx_timesheets_payroll_run_id
  ON timesheets (payroll_run_id)
  WHERE payroll_run_id IS NOT NULL;
