-- Rollback for Phase B2a — drop the auto-membership trigger and its function.
-- This file lives outside the main migrations folder (underscored directory),
-- so it is NOT auto-applied. Run manually via psql only if Phase B2a must be
-- reverted.
--
-- The backfilled rows in public.org_memberships are intentionally NOT removed
-- by this script — they are correct in any future world (single-tenant or
-- multi-tenant). If you genuinely need to remove them, do so per-row with
-- explicit user_id values; do not bulk-delete.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260501000000_phase_b2a_membership_integrity_down.sql

BEGIN;

DROP TRIGGER  IF EXISTS on_auth_user_created_membership ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user_membership();

COMMIT;
