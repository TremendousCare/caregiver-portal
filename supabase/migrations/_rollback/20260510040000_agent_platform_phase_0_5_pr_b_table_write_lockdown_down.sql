-- Rollback for the agent table write lockdown.
-- Re-grants INSERT/UPDATE/DELETE on public.agents and
-- public.agent_versions to the `authenticated` role, restoring the
-- Phase 0.1 RLS gap. Use only if the PR B SECURITY DEFINER RPCs are
-- also reverted (otherwise the lockdown's removal has no effect on
-- the actual write paths — the RPCs still work).

GRANT INSERT, UPDATE, DELETE ON public.agents          TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.agent_versions  TO authenticated;
