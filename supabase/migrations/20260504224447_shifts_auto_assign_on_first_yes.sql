-- Stub migration to reconcile pre-existing drift in the remote
-- migration tracker.
--
-- This `version` (20260504224447) was inserted into
-- `supabase_migrations.schema_migrations` on 2026-05-04 22:44:47 UTC
-- when the `auto_assign_on_first_yes` shift column was applied to
-- production directly — most likely via `supabase db push` from a
-- local branch (or the Supabase Studio SQL editor) ahead of the
-- official PR #265 merge. The same schema change later landed in the
-- repo as `20260506020000_shifts_auto_assign_on_first_yes.sql`.
--
-- The result: the remote tracker carries an entry for which no
-- corresponding file existed in `supabase/migrations/`, so the next
-- `supabase db push --include-all` run failed with:
--
--     Remote migration versions not found in local migrations
--     directory.
--
-- Adding this file restores parity. The body matches the SQL that
-- was actually applied (verified by querying
-- supabase_migrations.schema_migrations); both this file and
-- `20260506020000_shifts_auto_assign_on_first_yes.sql` use
-- `ADD COLUMN IF NOT EXISTS`, so re-applying either is a guaranteed
-- no-op against the live schema.
--
-- For new environments (a fresh staging spin-up, etc.) both
-- migrations run in order; the second is the no-op. The duplication
-- is mildly redundant but not harmful, and intentionally left in
-- place rather than deleting `20260506020000` so the merged PR
-- history stays intact.

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS auto_assign_on_first_yes boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN shifts.auto_assign_on_first_yes IS
  'If true, the first caregiver to reply "Yes" to a shift offer is auto-assigned, other pending offers are expired, and a confirmation SMS is sent. Set per-broadcast from the BroadcastModal checkbox.';
