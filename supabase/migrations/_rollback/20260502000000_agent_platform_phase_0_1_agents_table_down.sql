-- Rollback for Agent Platform Phase 0.1 — drop agents + agent_versions
-- and their RLS policies. This file lives outside the main migrations
-- folder (underscored directory), so it is NOT auto-applied. Run manually
-- via psql only if Phase 0.1 must be reverted.
--
-- Because Phase 0.1 is purely additive (two new tables, no other table
-- modified, no existing policy touched), dropping the tables and policies
-- returns the system to exactly the pre-0.1 state. No other data is
-- altered.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260502000000_agent_platform_phase_0_1_agents_table_down.sql

BEGIN;

-- 1. Drop the policies first. Use a targeted list rather than the
--    suffix-anchored regex from B2b — the regex would also match B2b's
--    160 production policies. We only want to drop the 8 policies this
--    migration created.
DO $$
DECLARE
  v_target text;
BEGIN
  FOREACH v_target IN ARRAY ARRAY['agents', 'agent_versions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                   'tenant_isolation_' || v_target || '_select', v_target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                   'tenant_isolation_' || v_target || '_insert', v_target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                   'tenant_isolation_' || v_target || '_update', v_target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
                   'tenant_isolation_' || v_target || '_delete', v_target);
  END LOOP;
END $$;

-- 2. Drop the trigger and its function.
DROP TRIGGER IF EXISTS agents_set_updated_at ON public.agents;
DROP FUNCTION IF EXISTS public.tg_agents_set_updated_at();

-- 3. Drop the tables. agent_versions has FK to agents; drop child first.
DROP TABLE IF EXISTS public.agent_versions;
DROP TABLE IF EXISTS public.agents;

COMMIT;
