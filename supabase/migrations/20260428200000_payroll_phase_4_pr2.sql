-- Paychex integration Phase 4 PR #2: storage bucket for CSV exports +
-- audit columns for inline timesheet edits + persisted per-rate
-- breakdown for the SPI export.
--
-- Four additive changes:
--
-- 1) Private Supabase Storage bucket `payroll-exports` for the SPI
--    "Hours Only Flexible" CSVs the `payroll-export-run` edge function
--    generates. Files are referenced by signed URL only (short-lived,
--    minutes); the bucket is NOT publicly readable. Object names follow
--    `<org_id>/<payroll_run_id>.csv` so even with a forged signed URL
--    a caller can only reach files they have a valid run id for, and
--    org-prefixing keeps the path mappable to a tenant by inspection.
--
-- 2) `timesheets.last_edited_by` (text), `timesheets.last_edited_at`
--    (timestamptz), `timesheets.last_edit_reason` (text). Inline edits
--    in the Phase 4 PR #2 UI capture the user, time, and required
--    reason on each save. The full edit-by-edit history is in the
--    `events` table (one `timesheet_adjusted` event per save); these
--    columns surface the most-recent edit cheaply on the row itself
--    without joining events for the read path.
--
-- 3) `payroll_runs.export_filename` (text). Records the on-disk name
--    of the exported CSV (e.g. `2026-04-20_run_abc123.csv`) so the
--    PR #3 PayrollRunsView can label "Download CSV" buttons by the
--    file the back office originally pulled.
--
-- 4) `timesheets.regular_by_rate` (jsonb) + `timesheets.regular_rate_of_pay`
--    (numeric). Persists the per-shift-rate aggregation and CA
--    weighted-average ROP that the OT engine computes at draft time.
--    The export function reads these straight off the row instead of
--    re-running buildTimesheet; cron + regenerate populate them on
--    insert. `regular_by_rate` shape: `[{rate: number, hours: number}, …]`
--    or `null` for legacy rows. Populated as drafts are
--    (re)generated; pre-existing drafts read `null` and the export
--    falls back to the legacy single-rate path via `hourly_rate`
--    fields the cron also persists (added below).
--
-- All changes are idempotent. Re-running the migration is safe.
--
-- Plan reference:
--   docs/plans/2026-04-25-paychex-integration-plan.md
--   docs/handoff-paychex-phase-4.md  ("PR #2 — Edits + approval + ...")

-- ── 1. Storage bucket ──────────────────────────────────────────────
-- Supabase ships a `storage.buckets` table; insert if missing.
INSERT INTO storage.buckets (id, name, public)
VALUES ('payroll-exports', 'payroll-exports', false)
ON CONFLICT (id) DO NOTHING;

-- RLS on storage.objects is owned by Supabase; we add tenant-aware
-- policies for this specific bucket. Authenticated reads are gated
-- on the JWT's org_id matching the path prefix; service role bypasses
-- (writes are made by the payroll-export-run edge function which runs
-- as service_role).
DO $$
BEGIN
  -- Authenticated read: a user can list/download an object only if
  -- the object's name starts with their JWT's org_id. The frontend
  -- never reads via this path in Phase 4 PR #2 — it always uses a
  -- signed URL minted by the edge function — but the policy keeps
  -- the bucket safe in case a future caller tries to read directly.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'tenant_isolation_payroll_exports_read'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "tenant_isolation_payroll_exports_read"
        ON storage.objects FOR SELECT
        TO authenticated
        USING (
          bucket_id = 'payroll-exports'
          AND (((SELECT auth.jwt()) ->> 'org_id')::text || '/') = split_part(name, '/', 1) || '/'
        );
    $POL$;
  END IF;

  -- Service role write: explicit policy so the intent is visible
  -- even though service_role bypasses RLS by default in Postgres.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'service_role_full_access_payroll_exports'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "service_role_full_access_payroll_exports"
        ON storage.objects FOR ALL
        TO service_role
        USING (bucket_id = 'payroll-exports')
        WITH CHECK (bucket_id = 'payroll-exports');
    $POL$;
  END IF;
END $$;

-- ── 2. Inline-edit audit columns on timesheets ────────────────────
ALTER TABLE timesheets
  ADD COLUMN IF NOT EXISTS last_edited_by    text;
ALTER TABLE timesheets
  ADD COLUMN IF NOT EXISTS last_edited_at    timestamptz;
ALTER TABLE timesheets
  ADD COLUMN IF NOT EXISTS last_edit_reason  text;

-- ── 3. Export filename on payroll_runs ────────────────────────────
ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS export_filename text;

-- ── 4. Persisted per-rate breakdown on timesheets ────────────────
-- regular_by_rate: jsonb array of {rate, hours} entries, one per
--   distinct shift hourly_rate within the workweek's regular hours.
--   Computed by timesheetBuilder.js (Phase 4 PR #2) at draft time.
--   Null for pre-PR-2 rows; export falls back to single-rate via the
--   row-level hourly_rate fallback.
-- regular_rate_of_pay: the CA weighted-average regular rate of pay
--   computed by overtimeRules.computeRegularRateOfPay. Used as the
--   base for OT (×1.5) / DT (×2) row rates in the SPI CSV.
ALTER TABLE timesheets
  ADD COLUMN IF NOT EXISTS regular_by_rate jsonb;
ALTER TABLE timesheets
  ADD COLUMN IF NOT EXISTS regular_rate_of_pay numeric(10,4);
