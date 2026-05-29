-- Rollback for QuickBooks integration PR #2 (OAuth states + RPCs).
-- Drops the quickbooks_oauth_states table, its policies, the three
-- new RPCs (init_qb_oauth_state, complete_qb_oauth,
-- cleanup_expired_qb_oauth_states).
--
-- This file lives under _rollback/ and is NOT auto-applied. Run
-- manually via psql only if PR #2 must be reverted:
--
--   psql "$SUPABASE_DB_URL" -f \
--     supabase/migrations/_rollback/20260529110000_quickbooks_oauth_states_down.sql
--
-- PR #2 is purely additive on top of PR #1; reverting it leaves the
-- quickbooks_connections table from PR #1 intact (any already-issued
-- OAuth connection remains usable until manually cleared via
-- public.clear_qb_connection).
--
-- Any in-flight oauth states (rows whose state_id is sitting in a
-- user's browser mid-redirect) become orphaned and will surface as
-- "state not found" errors at the callback — acceptable since the
-- whole feature is being reverted.

BEGIN;

-- 1. Drop policies.
DO $$
DECLARE
  cmd text;
BEGIN
  FOR cmd IN SELECT unnest(ARRAY['select', 'insert', 'update', 'delete']) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.quickbooks_oauth_states',
                   'quickbooks_oauth_states_owner_' || cmd);
  END LOOP;
END $$;

-- 2. Drop functions.
DROP FUNCTION IF EXISTS public.init_qb_oauth_state(text);
DROP FUNCTION IF EXISTS public.complete_qb_oauth(
  uuid, text, text, text, timestamptz, timestamptz, text[]
);
DROP FUNCTION IF EXISTS public.cleanup_expired_qb_oauth_states();

-- 3. Drop the table.
DROP TABLE IF EXISTS public.quickbooks_oauth_states;

COMMIT;
