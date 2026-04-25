-- ═══════════════════════════════════════════════════════════════
-- shifts — no-show tracking columns
--
-- Mirrors the existing cancel pattern (cancel_reason / cancelled_at /
-- cancelled_by) so the office staff can mark a shift as a no-show with
-- a free-form note plus an audit stamp of who marked it and when.
--
-- The 'no_show' status value already exists in the shifts.status check
-- constraint (added in 20260414235959). This migration only adds the
-- supporting metadata columns. All columns are nullable / additive —
-- old rows continue to work unchanged.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS no_show_note         text,
  ADD COLUMN IF NOT EXISTS marked_no_show_at    timestamptz,
  ADD COLUMN IF NOT EXISTS marked_no_show_by    text;
