-- Rollback for the anon privilege cleanup.
-- Re-grants the three privileges to anon. RLS still denies anon
-- writes, so this rollback restores the (already-safe) PR #300/#301
-- state — only run if you specifically need the table-level
-- privileges restored for some debugging reason.

GRANT INSERT, UPDATE, DELETE ON public.agents          TO anon;
GRANT INSERT, UPDATE, DELETE ON public.agent_versions  TO anon;
GRANT INSERT, UPDATE, DELETE ON public.agent_actions   TO anon;
