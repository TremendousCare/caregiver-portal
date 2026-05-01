-- Rollback for Agent Platform Phase 0.2 — drop agent_id columns +
-- supporting indexes from the four AI-tier tables. This file lives
-- outside the main migrations folder, so it is NOT auto-applied. Run
-- manually via psql only if Phase 0.2 must be reverted.
--
-- Because Phase 0.2 is purely additive (column add + backfill + new
-- indexes), dropping the columns and indexes returns the system to
-- exactly the pre-0.2 state. No data on existing columns is altered.
--
-- Running this script:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/_rollback/20260503000000_agent_platform_phase_0_2_agent_id_columns_down.sql
--
-- Note: the agents and agent_versions tables from Phase 0.1 stay in
-- place. To roll back further, run the Phase 0.1 down script after
-- this one.

BEGIN;

-- 1. Drop the indexes (independent of column drops, but cleaner first).
DROP INDEX IF EXISTS public.idx_events_org_agent_time;
DROP INDEX IF EXISTS public.idx_action_outcomes_org_agent_time;
DROP INDEX IF EXISTS public.idx_ai_suggestions_org_agent_time;
DROP INDEX IF EXISTS public.idx_context_memory_org_agent_time;

-- 2. Drop the agent_id columns. The FK is removed automatically with
--    the column. Other columns and rows stay untouched.
ALTER TABLE public.events           DROP COLUMN IF EXISTS agent_id;
ALTER TABLE public.action_outcomes  DROP COLUMN IF EXISTS agent_id;
ALTER TABLE public.ai_suggestions   DROP COLUMN IF EXISTS agent_id;
ALTER TABLE public.context_memory   DROP COLUMN IF EXISTS agent_id;

COMMIT;
