-- Rollback for 20260511000002_voice_phase1_call_sessions.sql
-- Lives outside the auto-applied migrations folder; run manually via
-- psql ONLY if the feature must be reverted.
--
-- Drops the call session tracking table and all its policies and
-- indexes. Before running:
--   1. Pause the Telephony Sessions webhook subscription so the
--      handler stops trying to upsert rows here.
--   2. Pause any post-call transcription worker scanning this table.
--   3. Decide whether to also roll back communication_voice_config
--      (separate script).
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260511000002_voice_phase1_call_sessions_down.sql

DROP POLICY IF EXISTS "service_role_full_access_call_sessions" ON public.call_sessions;
DROP POLICY IF EXISTS "tenant_isolation_call_sessions_select"  ON public.call_sessions;
DROP POLICY IF EXISTS "tenant_isolation_call_sessions_insert"  ON public.call_sessions;
DROP POLICY IF EXISTS "tenant_isolation_call_sessions_update"  ON public.call_sessions;
DROP POLICY IF EXISTS "tenant_isolation_call_sessions_delete"  ON public.call_sessions;

DROP INDEX IF EXISTS public.idx_call_sessions_pending_transcript;
DROP INDEX IF EXISTS public.idx_call_sessions_matched_user;
DROP INDEX IF EXISTS public.idx_call_sessions_matched_entity;
DROP INDEX IF EXISTS public.idx_call_sessions_org_started;

DROP TABLE IF EXISTS public.call_sessions;
