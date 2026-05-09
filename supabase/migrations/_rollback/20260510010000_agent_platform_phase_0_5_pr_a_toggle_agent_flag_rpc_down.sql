-- Rollback for Phase 0.5 PR A — toggle_agent_flag_v1 RPC.
-- Drops the function. The Settings UI that calls it returns to its
-- pre-PR-A state where toggles aren't possible from the UI; admins
-- can still toggle via direct SQL UPDATE on `public.agents`.

DROP FUNCTION IF EXISTS public.toggle_agent_flag_v1(uuid, text, boolean);
