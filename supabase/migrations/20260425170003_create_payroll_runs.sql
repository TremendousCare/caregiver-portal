-- Paychex integration Phase 1: payroll_runs table.
--
-- A batch of timesheets submitted to Paychex together. The Phase 4
-- "Generate Payroll Run" action collects all approved timesheets for
-- the current pay period into one payroll_runs row, then either
-- exports a CSV (Phase 4 path; submission_mode = 'csv_export') or
-- POSTs directly to Paychex /paydata (Phase 5 path; submission_mode
-- = 'api_direct'). Both modes coexist permanently — a back-office
-- user picks per run.
--
-- See: docs/plans/2026-04-25-paychex-integration-plan.md
--      ("Data model" → "New tables" → "payroll_runs").

CREATE TABLE IF NOT EXISTS payroll_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  pay_period_start    date NOT NULL,
  pay_period_end      date NOT NULL,
  pay_date            date NOT NULL,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN (
                          'draft', 'exported', 'submitted',
                          'processing', 'completed', 'failed'
                        )),
  -- Which Phase exported this run? CSV-export (Phase 4) or direct
  -- API (Phase 5). Locked in at "Generate Run" time so the back
  -- office cannot accidentally double-submit a run that's already
  -- in flight via the other path.
  submission_mode     text NOT NULL DEFAULT 'csv_export'
                        CHECK (submission_mode IN ('csv_export', 'api_direct')),
  timesheet_count     int  NOT NULL DEFAULT 0,
  total_gross         numeric(12,2) NOT NULL DEFAULT 0,
  total_mileage       numeric(10,2) NOT NULL DEFAULT 0,
  -- Supabase Storage path for the generated CSV (Phase 4). Null for
  -- api_direct runs.
  csv_export_url      text,
  -- Phase 5 only; null indefinitely if TC stays on CSV path.
  paychex_payperiod_id text,
  submitted_by        text,
  submitted_at        timestamptz,
  -- Set when the back office marks a CSV run "Paid in Paychex"
  -- (Phase 4 path) or when the Paychex webhook fires for an api_direct
  -- run (Phase 5 path).
  completed_at        timestamptz,
  error_details       jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Org-scoped uniqueness: one run per org per pay period per pay date.
  -- Rare edge case where you'd intentionally do two runs for the same
  -- date (e.g., bonus run) is out of v1 scope per Decisions section
  -- ("Off-cycle payroll: out of scope for v1, manual via Paychex UI").
  CONSTRAINT payroll_runs_unique_per_period UNIQUE (org_id, pay_period_start, pay_date)
);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_pay_date
  ON payroll_runs (org_id, pay_date DESC);

-- Phase 4 PayrollRunsView lists "active" runs (not yet completed).
CREATE INDEX IF NOT EXISTS idx_payroll_runs_active_status
  ON payroll_runs (org_id, status)
  WHERE status IN ('draft', 'exported', 'submitted', 'processing', 'failed');

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_payroll_runs"
  ON payroll_runs FOR ALL
  TO authenticated
  USING      (((SELECT auth.jwt()) ->> 'org_id')::uuid = org_id)
  WITH CHECK (((SELECT auth.jwt()) ->> 'org_id')::uuid = org_id);

CREATE POLICY "service_role_full_access_payroll_runs"
  ON payroll_runs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
