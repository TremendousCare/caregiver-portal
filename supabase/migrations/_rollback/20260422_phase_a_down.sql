-- Rollback script for Phase A — Auth foundation.
-- This file lives outside the main migrations folder (underscored
-- directory) so it is NOT auto-applied. Run manually via psql only
-- if Phase A must be reverted.
--
-- PRE-STEP (MANUAL, REQUIRED):
--   Supabase Dashboard → Authentication → Hooks → disable the
--   Custom Access Token Hook BEFORE running this script. Otherwise
--   dropping the function will break token issuance for every user.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260422_phase_a_down.sql

BEGIN;

DROP FUNCTION IF EXISTS public.custom_access_token_hook(jsonb);
DROP TABLE    IF EXISTS public.org_memberships;
DROP TABLE    IF EXISTS public.organizations;

COMMIT;
