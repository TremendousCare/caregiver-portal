-- Rollback for 20260516020001_..._seed_call_analyst_agent.sql
--
-- Removes the call_analyst agent row + its agent_versions snapshot.
-- The ON DELETE CASCADE on agent_versions.agent_id_fkey makes the
-- snapshot deletion automatic; explicit deletion below is belt-and-
-- suspenders.
--
-- WARNING: this runs against the org-scoped row. If any
-- `ai_suggestions` row was written by this agent while it was live,
-- it will lose its agent_id FK reference. Phase 0.2's backfill
-- pattern leaves agent_id as nullable, so the rows persist but lose
-- attribution. Confirm zero ai_suggestions referencing this agent
-- before rolling back:
--   SELECT count(*) FROM ai_suggestions
--    WHERE agent_id = (SELECT id FROM agents WHERE slug = 'call_analyst');

DELETE FROM public.agent_versions
 WHERE agent_id IN (
   SELECT id FROM public.agents
    WHERE org_id = public.default_org_id()
      AND slug   = 'call_analyst'
 );

DELETE FROM public.agents
 WHERE org_id = public.default_org_id()
   AND slug   = 'call_analyst';
