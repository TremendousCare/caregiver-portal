-- Rollback for 20260428200000_payroll_phase_4_pr2.sql
--
-- Manual / break-glass only. Run via psql against the dev/staging DB
-- when you need to undo Phase 4 PR #2's additive changes. NEVER run
-- against production unless production has just merged the rollback
-- of PR #2 itself.
--
-- Order matters: drop policies before bucket so the bucket delete
-- doesn't trip RLS on a non-empty bucket.

-- ── 1. Storage bucket policies + bucket ──────────────────────────
DROP POLICY IF EXISTS "tenant_isolation_payroll_exports_read"
  ON storage.objects;
DROP POLICY IF EXISTS "service_role_full_access_payroll_exports"
  ON storage.objects;

-- Defensive: empty the bucket before dropping (Supabase refuses to
-- drop a non-empty bucket). This is irreversible — never run on
-- production unless you understand the consequences.
DELETE FROM storage.objects WHERE bucket_id = 'payroll-exports';
DELETE FROM storage.buckets WHERE id = 'payroll-exports';

-- ── 2. Inline-edit audit columns on timesheets ───────────────────
ALTER TABLE timesheets DROP COLUMN IF EXISTS last_edit_reason;
ALTER TABLE timesheets DROP COLUMN IF EXISTS last_edited_at;
ALTER TABLE timesheets DROP COLUMN IF EXISTS last_edited_by;

-- ── 3. Export filename on payroll_runs ───────────────────────────
ALTER TABLE payroll_runs DROP COLUMN IF EXISTS export_filename;
