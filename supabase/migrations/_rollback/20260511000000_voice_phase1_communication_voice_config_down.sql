-- Rollback for 20260511000000_voice_phase1_communication_voice_config.sql
-- Lives outside the auto-applied migrations folder; run manually via
-- psql ONLY if the feature must be reverted.
--
-- Drops the per-org voice configuration table and all its policies.
-- Safe to run idempotently. Before running:
--   1. Confirm the Telephony Sessions webhook subscription is paused
--      (otherwise the handler will start failing inserts to
--      call_sessions if call_sessions is also rolled back).
--   2. Stop any cron job that renews the voice webhook subscription.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260511000000_voice_phase1_communication_voice_config_down.sql

DROP POLICY IF EXISTS "service_role_full_access_communication_voice_config"
  ON public.communication_voice_config;
DROP POLICY IF EXISTS "tenant_isolation_communication_voice_config_select"
  ON public.communication_voice_config;
DROP POLICY IF EXISTS "tenant_isolation_communication_voice_config_insert"
  ON public.communication_voice_config;
DROP POLICY IF EXISTS "tenant_isolation_communication_voice_config_update"
  ON public.communication_voice_config;
DROP POLICY IF EXISTS "tenant_isolation_communication_voice_config_delete"
  ON public.communication_voice_config;

DROP INDEX IF EXISTS public.idx_communication_voice_config_subscription_expiry;
DROP INDEX IF EXISTS public.idx_communication_voice_config_subscription;

DROP TABLE IF EXISTS public.communication_voice_config;
