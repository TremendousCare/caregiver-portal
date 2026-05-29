-- Rollback for QuickBooks integration PR #1.
-- Drops the quickbooks_connections table, its policies, the three
-- RPCs (set_qb_connection_tokens, get_qb_connection,
-- clear_qb_connection), and any Vault secrets that were written by
-- live OAuth flows during the bake period.
--
-- This file lives under _rollback/ and is NOT auto-applied. Run
-- manually via psql only if PR #1 must be reverted:
--
--   psql "$SUPABASE_DB_URL" -f \
--     supabase/migrations/_rollback/20260529100000_quickbooks_connections_down.sql
--
-- PR #1 is purely additive (one new table, three new functions, no
-- existing table or function touched), so dropping these returns the
-- system to exactly the pre-PR-1 state. Deleting Vault secrets is
-- safe because no consumer reads them yet — PR #2 is what wires the
-- OAuth callback that produces them.

BEGIN;

-- 1. Drop policies first.
DO $$
DECLARE
  cmd text;
BEGIN
  FOR cmd IN SELECT unnest(ARRAY['select', 'insert', 'update', 'delete']) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.quickbooks_connections',
                   'quickbooks_connections_owner_' || cmd);
  END LOOP;
  EXECUTE 'DROP POLICY IF EXISTS quickbooks_connections_admin_select '
       || 'ON public.quickbooks_connections';
END $$;

-- 2. Drop trigger.
DROP TRIGGER IF EXISTS quickbooks_connections_touch_updated_at
  ON public.quickbooks_connections;

-- 3. Drop functions.
DROP FUNCTION IF EXISTS public.set_qb_connection_tokens(
  uuid, text, text, text, text, timestamptz, timestamptz, text[]
);
DROP FUNCTION IF EXISTS public.get_qb_connection(uuid, text);
DROP FUNCTION IF EXISTS public.clear_qb_connection(uuid, text);

-- 4. Drop any Vault secrets written by live OAuth flows during bake.
-- Pattern matches the secret names produced by set_qb_connection_tokens.
DELETE FROM vault.secrets
WHERE name LIKE 'qb_refresh_token_%'
   OR name LIKE 'qb_access_token_%';

-- 5. Drop the table.
DROP TABLE IF EXISTS public.quickbooks_connections;

COMMIT;
