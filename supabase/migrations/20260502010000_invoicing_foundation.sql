-- Invoicing Phase 1 — foundation schema.
--
-- Adds the data model for billing clients directly from the portal:
--   - clients gets three additive columns: default_billable_rate,
--     default_billable_ot_rate, payer_type (all nullable; clients
--     without rates simply produce a `client_missing_rate` exception
--     when an invoice is built, the same way payroll surfaces missing
--     hourly_rate).
--   - invoices: one row per (org, client, billing period). Mirrors
--     timesheets — same status ladder, same audit columns — so anyone
--     who has worked the payroll table feels at home.
--   - invoice_shifts: junction from invoice → shift with the per-shift
--     billable_rate and hour_classification snapshotted at draft time.
--   - invoice_runs: batch wrapper for a billing cycle's exported set.
--     Mirrors payroll_runs for the QBO CSV export path.
--
-- Phase 1 is read-only on the UI side: the tables exist, the schema is
-- production-shaped, and the CLAUDE.md / SaaS-retrofit prime directives
-- are satisfied (org_id NOT NULL with default + four tenant_isolation
-- policies). Phase 2 wires up the cron, approval workflow, and writes.
-- Phase 3 wires up CSV export to QuickBooks.
--
-- Tenant isolation:
--   Per the SaaS retrofit Phase B locked decisions (docs/SAAS_RETROFIT.md
--   → "Decisions locked"), every new table:
--     1. Has org_id uuid NOT NULL DEFAULT public.default_org_id()
--        REFERENCES organizations(id).
--     2. Has an index on org_id.
--     3. Carries four permissive `tenant_isolation_<table>_<command>`
--        policies named with the suffix-anchored regex pattern locked
--        in PR #237. Predicate is fail-closed:
--        org_id = nullif(auth.jwt() ->> 'org_id', '')::uuid
--     4. Carries a `service_role_full_access_<table>` policy so the
--        Phase 2 cron + edge functions can write via the service role.
--
-- Plan reference:
--   CLAUDE.md → "Strategic Context: Becoming Multi-Tenant SaaS"
--   docs/INVOICING.md (new in this PR)

-- ─────────────────────────────────────────────────────────────────
-- 1. Additive columns on clients
-- ─────────────────────────────────────────────────────────────────
--
-- Per-shift billable_rate (on the shifts table) is the existing source
-- of truth for what a client gets charged. These columns add a
-- client-level fallback so a missed shift-rate doesn't silently zero
-- out a line item — the invoice builder reads `shifts.billable_rate ??
-- clients.default_billable_rate`. If both are null, the builder emits
-- a `client_missing_rate` block-severity exception.
--
-- payer_type is freeform text (no enum) in v1 — we know we'll need
-- private_pay / medicaid / ltc_insurance / va / other but we don't yet
-- know which ones each org wants and what authorization fields they
-- imply. A text column lets us iterate without a CHECK-constraint
-- migration each time. A future Phase introduces a payer_types lookup
-- table when the values stabilize.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS default_billable_rate    numeric(10,2);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS default_billable_ot_rate numeric(10,2);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payer_type               text;

-- ─────────────────────────────────────────────────────────────────
-- 2. invoices
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL DEFAULT public.default_org_id()
                              REFERENCES organizations(id) ON DELETE RESTRICT,
  client_id                text NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  -- Human-readable invoice number (e.g., TC-2026-0001). NULL on draft;
  -- assigned by the Phase 3 export flow from the per-org sequence.
  invoice_number           text,
  -- Workweek window in the org's timezone. End is inclusive (Sunday).
  -- Mirrors timesheets.pay_period_start / pay_period_end.
  billing_period_start     date NOT NULL,
  billing_period_end       date NOT NULL,
  status                   text NOT NULL DEFAULT 'draft'
                              CHECK (status IN (
                                'draft', 'pending_approval', 'approved',
                                'exported', 'sent', 'paid',
                                'rejected', 'blocked'
                              )),
  -- Hours rolled up at draft generation. Pulled from the shifts +
  -- timesheet_shifts (when payroll has run) so caregiver-OT hours
  -- attributed to this client also bill at the OT rate.
  regular_hours            numeric(6,2)  NOT NULL DEFAULT 0,
  overtime_hours           numeric(6,2)  NOT NULL DEFAULT 0,
  double_time_hours        numeric(6,2)  NOT NULL DEFAULT 0,
  -- Rates resolved AT DRAFT TIME, snapshotted onto the invoice so a
  -- later edit to clients.default_billable_rate doesn't retroactively
  -- rewrite an issued invoice. Null only when shifts have varying
  -- rates; in that case the per-shift rate on invoice_shifts is the
  -- source of truth and the UI shows "Mixed".
  regular_rate             numeric(10,2),
  ot_rate                  numeric(10,2),
  -- Money. `total` equals `subtotal` in v1; tax / discount / credit
  -- columns land here in a future phase without breaking the wire.
  subtotal                 numeric(12,2) NOT NULL DEFAULT 0,
  total                    numeric(12,2) NOT NULL DEFAULT 0,
  -- Approval audit (Phase 2)
  approved_by              text,
  approved_at              timestamptz,
  -- Lifecycle markers (Phase 2/3): exported = CSV/PDF emitted; sent =
  -- delivered to client; paid = QBO confirms payment (manual mark
  -- in v1).
  exported_at              timestamptz,
  sent_at                  timestamptz,
  paid_at                  timestamptz,
  -- Inline-edit audit (Phase 2)
  last_edited_by           text,
  last_edited_at           timestamptz,
  last_edit_reason         text,
  -- Populated when status = 'blocked' (e.g., client missing rate,
  -- missing billing address, no shifts in period).
  block_reason             text,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- Org-scoped uniqueness: one invoice per client per billing period
  -- per org. Same shape as timesheets_unique_per_period.
  CONSTRAINT invoices_unique_per_period UNIQUE (org_id, client_id, billing_period_start)
);

CREATE INDEX IF NOT EXISTS idx_invoices_org_period
  ON invoices (org_id, billing_period_start DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_client_period
  ON invoices (client_id, billing_period_start DESC);

-- "What needs review?" view — keep the index small.
CREATE INDEX IF NOT EXISTS idx_invoices_actionable_status
  ON invoices (org_id, status)
  WHERE status IN ('draft', 'pending_approval', 'blocked');

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

-- Tenant isolation policies — one per command. Naming follows the
-- B2b convention locked in docs/SAAS_RETROFIT_STATUS.md (PR #237):
-- tenant_isolation_<table>_<select|insert|update|delete>. Predicate
-- is fail-closed: missing/empty/malformed claim denies. The cast is
-- inside the predicate so a missing claim = denied silently rather
-- than raising during query planning.
CREATE POLICY "tenant_isolation_invoices_select"
  ON invoices FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "tenant_isolation_invoices_insert"
  ON invoices FOR INSERT
  TO authenticated
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "tenant_isolation_invoices_update"
  ON invoices FOR UPDATE
  TO authenticated
  USING      (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid)
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "tenant_isolation_invoices_delete"
  ON invoices FOR DELETE
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "service_role_full_access_invoices"
  ON invoices FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────
-- 3. invoice_shifts
-- ─────────────────────────────────────────────────────────────────
--
-- Junction from invoice → shift with the per-shift billable rate and
-- hour classification snapshotted at draft time. Tenant isolation is
-- inherited via the parent invoice (subquery in the policy) — same
-- pattern as timesheet_shifts. No org_id column on the junction so
-- it cannot drift from its parent's org.

CREATE TABLE IF NOT EXISTS invoice_shifts (
  invoice_id            uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  shift_id              uuid NOT NULL REFERENCES shifts(id)   ON DELETE RESTRICT,
  hours_worked          numeric(5,2) NOT NULL DEFAULT 0,
  hour_classification   text NOT NULL
                          CHECK (hour_classification IN ('regular', 'overtime', 'double_time')),
  -- Rate applied to this shift's hours on this invoice. Snapshotted so
  -- a later edit to shifts.billable_rate doesn't rewrite the invoice.
  -- May differ from shift.billable_rate if the back office overrode it
  -- in the invoice editor (Phase 2).
  billable_rate_applied numeric(10,2),
  PRIMARY KEY (invoice_id, shift_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_shifts_shift
  ON invoice_shifts (shift_id);

ALTER TABLE invoice_shifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_invoice_shifts_select"
  ON invoice_shifts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_shifts.invoice_id
        AND i.org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    )
  );

CREATE POLICY "tenant_isolation_invoice_shifts_insert"
  ON invoice_shifts FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_shifts.invoice_id
        AND i.org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    )
  );

CREATE POLICY "tenant_isolation_invoice_shifts_update"
  ON invoice_shifts FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_shifts.invoice_id
        AND i.org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_shifts.invoice_id
        AND i.org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    )
  );

CREATE POLICY "tenant_isolation_invoice_shifts_delete"
  ON invoice_shifts FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_shifts.invoice_id
        AND i.org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid
    )
  );

CREATE POLICY "service_role_full_access_invoice_shifts"
  ON invoice_shifts FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────
-- 4. invoice_runs
-- ─────────────────────────────────────────────────────────────────
--
-- A batch of invoices generated together for a billing cycle. The
-- Phase 3 "Generate Invoice Run" action collects every approved
-- invoice for the period into one invoice_runs row, then either
-- exports a QuickBooks-shaped CSV (export_mode = 'csv_export') or
-- (future) calls the QuickBooks Online API directly. Mirrors
-- payroll_runs nearly 1:1.

CREATE TABLE IF NOT EXISTS invoice_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL DEFAULT public.default_org_id()
                        REFERENCES organizations(id) ON DELETE RESTRICT,
  billing_period_start date NOT NULL,
  billing_period_end   date NOT NULL,
  -- Date the back office is invoicing on (typically the Wednesday
  -- after the workweek closes). Locked at run-generation time so
  -- re-running for the same week doesn't accidentally double-issue.
  invoice_date        date NOT NULL,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN (
                          'draft', 'exported', 'sent',
                          'completed', 'failed'
                        )),
  -- csv_export covers the QBO IIF/CSV path (Phase 3). qbo_api is
  -- placeholder for a future direct-integration path.
  export_mode         text NOT NULL DEFAULT 'csv_export'
                        CHECK (export_mode IN ('csv_export', 'qbo_api')),
  invoice_count       int  NOT NULL DEFAULT 0,
  total_hours         numeric(10,2) NOT NULL DEFAULT 0,
  total_amount        numeric(12,2) NOT NULL DEFAULT 0,
  -- Supabase Storage path for the generated CSV (Phase 3). NULL on
  -- pre-export drafts.
  csv_export_url      text,
  export_filename     text,
  exported_by         text,
  exported_at         timestamptz,
  completed_at        timestamptz,
  error_details       jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Org-scoped uniqueness: one run per org per billing period per
  -- invoice_date. Bonus / off-cycle runs are out of v1 scope.
  CONSTRAINT invoice_runs_unique_per_period UNIQUE (org_id, billing_period_start, invoice_date)
);

CREATE INDEX IF NOT EXISTS idx_invoice_runs_org_invoice_date
  ON invoice_runs (org_id, invoice_date DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_runs_active_status
  ON invoice_runs (org_id, status)
  WHERE status IN ('draft', 'exported', 'failed');

ALTER TABLE invoice_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_invoice_runs_select"
  ON invoice_runs FOR SELECT
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "tenant_isolation_invoice_runs_insert"
  ON invoice_runs FOR INSERT
  TO authenticated
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "tenant_isolation_invoice_runs_update"
  ON invoice_runs FOR UPDATE
  TO authenticated
  USING      (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid)
  WITH CHECK (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "tenant_isolation_invoice_runs_delete"
  ON invoice_runs FOR DELETE
  TO authenticated
  USING (org_id = nullif((SELECT auth.jwt()) ->> 'org_id', '')::uuid);

CREATE POLICY "service_role_full_access_invoice_runs"
  ON invoice_runs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────
-- 5. Enable invoicing for Tremendous Care
-- ─────────────────────────────────────────────────────────────────
--
-- Toggle the feature flag so the Phase 1 read-only UI is visible to
-- TC's back office. Other orgs stay off until they opt in. The flag
-- lives in organizations.settings.features_enabled.invoicing — same
-- shape as the existing features_enabled.payroll flag from the
-- Paychex integration.

UPDATE organizations
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{features_enabled,invoicing}',
  'true'::jsonb,
  true
)
WHERE slug = 'tremendous-care';
