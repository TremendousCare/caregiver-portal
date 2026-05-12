-- Rollback for 20260511000001_voice_phase1_org_memberships_extension_id.sql
-- Lives outside the auto-applied migrations folder; run manually via
-- psql ONLY if the feature must be reverted.
--
-- Drops the per-user RingCentral extension mapping column and its
-- indexes. Safe to run idempotently. Any extension assignments are
-- lost on rollback — they live only in this column.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260511000001_voice_phase1_org_memberships_extension_id_down.sql

DROP INDEX IF EXISTS public.uniq_org_memberships_rc_extension_per_org;
DROP INDEX IF EXISTS public.idx_org_memberships_rc_extension;

ALTER TABLE public.org_memberships
  DROP COLUMN IF EXISTS ringcentral_extension_id;
