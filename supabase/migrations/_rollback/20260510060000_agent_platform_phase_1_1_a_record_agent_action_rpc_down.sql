-- Rollback for record_agent_action_v1.
-- Drops the RPC. After rollback, agent_actions has no legitimate
-- write path under the authenticated role — pair with the table
-- rollback if Phase 1.1 is being abandoned wholesale.

DROP FUNCTION IF EXISTS public.record_agent_action_v1(
  uuid, uuid, integer, text, text, text, uuid, text, jsonb, uuid, text, text, text
);
