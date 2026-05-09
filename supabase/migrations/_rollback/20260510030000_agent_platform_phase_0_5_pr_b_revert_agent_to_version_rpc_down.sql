-- Rollback for revert_agent_to_version_v1.
-- Drops the function. Reverts via Supabase Dashboard (load snapshot,
-- copy fields back manually) until the RPC is restored.

DROP FUNCTION IF EXISTS public.revert_agent_to_version_v1(uuid, integer, text);
