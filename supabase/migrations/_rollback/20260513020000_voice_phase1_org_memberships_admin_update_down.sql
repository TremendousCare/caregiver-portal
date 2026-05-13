-- Rollback for 20260513020000_voice_phase1_org_memberships_admin_update.sql
-- Run manually only if admins no longer need to update org_memberships
-- from the Voice & Calls admin panel.
--
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260513020000_voice_phase1_org_memberships_admin_update_down.sql

DROP POLICY IF EXISTS "admins_update_org_memberships" ON public.org_memberships;
