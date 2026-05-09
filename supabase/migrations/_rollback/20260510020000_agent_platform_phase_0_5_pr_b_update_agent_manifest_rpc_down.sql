-- Rollback for update_agent_manifest_v1.
-- Drops the function. The Settings UI's edit/save path returns to its
-- pre-PR-B state where the [Save…] button shows "function does not
-- exist" toast — admins can edit via the Supabase Dashboard until the
-- RPC is restored.

DROP FUNCTION IF EXISTS public.update_agent_manifest_v1(uuid, integer, jsonb, text);
