-- Rollback for QuickBooks integration PR #3 (token refresh cron).
-- Unschedules the pg_cron entry. Edge function code stays deployed
-- but becomes unreachable from cron — it can still be triggered
-- manually for one-off refreshes if needed.
--
-- This file lives under _rollback/ and is NOT auto-applied. Run
-- manually via psql only if PR #3 must be reverted:
--
--   psql "$SUPABASE_DB_URL" -f \
--     supabase/migrations/_rollback/20260603000000_quickbooks_token_refresh_cron_down.sql

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'quickbooks-token-refresh') THEN
    PERFORM cron.unschedule('quickbooks-token-refresh');
  END IF;
END
$$;

COMMIT;
