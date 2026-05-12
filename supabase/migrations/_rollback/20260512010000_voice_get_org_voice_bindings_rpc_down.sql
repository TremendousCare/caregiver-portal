-- Rollback for 20260512010000_voice_get_org_voice_bindings_rpc.sql
-- Run manually via psql if the RPC must be removed.
--
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260512010000_voice_get_org_voice_bindings_rpc_down.sql

DROP FUNCTION IF EXISTS public.get_org_voice_bindings();
