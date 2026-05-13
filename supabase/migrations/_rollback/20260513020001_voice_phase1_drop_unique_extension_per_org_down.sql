-- Rollback for 20260513020001_voice_phase1_drop_unique_extension_per_org.sql
-- Re-creates the unique constraint that prevented multiple users
-- from binding to the same RC extension. NOTE: will FAIL if multiple
-- users are currently bound to the same extension. Deduplicate first
-- if this rollback is required.
--
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260513020001_voice_phase1_drop_unique_extension_per_org_down.sql

CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_memberships_rc_extension_per_org
  ON public.org_memberships (org_id, ringcentral_extension_id)
  WHERE ringcentral_extension_id IS NOT NULL;
