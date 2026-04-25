-- Paychex integration Phase 1: timesheet_shifts junction table.
--
-- Links each timesheet to the shifts it covers, with the per-shift
-- hour classification (regular vs overtime vs double-time) the OT
-- engine produced in Phase 3. Lets the Phase 4 UI expand a row to
-- show "which shifts make up this paycheck?" with clock-in/out times
-- and any flagged exceptions.
--
-- Tenant isolation is inherited via the parent timesheet — RLS uses
-- a subquery into `timesheets` rather than a duplicate org_id column,
-- so we cannot get into a state where the junction row's org disagrees
-- with the parent timesheet's org.
--
-- See: docs/plans/2026-04-25-paychex-integration-plan.md
--      ("Data model" → "New tables" → "timesheet_shifts").

CREATE TABLE IF NOT EXISTS timesheet_shifts (
  timesheet_id        uuid NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  shift_id            uuid NOT NULL REFERENCES shifts(id)     ON DELETE RESTRICT,
  hours_worked        numeric(5,2) NOT NULL DEFAULT 0,
  hour_classification text NOT NULL
                        CHECK (hour_classification IN ('regular', 'overtime', 'double_time')),
  mileage             numeric(6,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (timesheet_id, shift_id)
);

-- Reverse lookup: given a shift, which timesheet(s) include it?
-- Useful for Phase 3 idempotency (don't double-count a shift that
-- somehow ended up in two timesheets) and for audit queries.
CREATE INDEX IF NOT EXISTS idx_timesheet_shifts_shift
  ON timesheet_shifts (shift_id);

ALTER TABLE timesheet_shifts ENABLE ROW LEVEL SECURITY;

-- Tenant isolation via the parent timesheet's org_id. The subquery
-- avoids an org_id column on this junction (which would be a denorm
-- waiting to drift). Both USING and WITH CHECK gate on the parent.
CREATE POLICY "tenant_isolation_timesheet_shifts"
  ON timesheet_shifts FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM timesheets t
      WHERE t.id = timesheet_shifts.timesheet_id
        AND ((SELECT auth.jwt()) ->> 'org_id')::uuid = t.org_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM timesheets t
      WHERE t.id = timesheet_shifts.timesheet_id
        AND ((SELECT auth.jwt()) ->> 'org_id')::uuid = t.org_id
    )
  );

CREATE POLICY "service_role_full_access_timesheet_shifts"
  ON timesheet_shifts FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
