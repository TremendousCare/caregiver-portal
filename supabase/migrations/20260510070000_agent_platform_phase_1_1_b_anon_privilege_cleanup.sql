-- Phase 1.1.B — anon privilege cleanup on the agent-platform tables.
--
-- Background. The lockdown migrations on `agents` (PR #300) and
-- `agent_versions` (PR #300) and `agent_actions` (PR #301) revoked
-- INSERT/UPDATE/DELETE from `authenticated` only. The `anon` role
-- retained those table privileges by Supabase's default grant
-- pattern. RLS catches anon writes (no INSERT/UPDATE/DELETE policy
-- exists for the anon-without-JWT shape), so the actual security
-- posture is correct. But the table-privilege list is untidy — a
-- future engineer scanning `\dp public.agents` would see anon with
-- write privileges and reasonably worry.
--
-- This migration tightens defense in depth: REVOKE the same three
-- privileges from anon on all three audit-tier tables. After this
-- migration:
--   anon:          SELECT only (and the SELECT policy denies because
--                  no JWT → null org_id → no rows visible)
--   authenticated: SELECT only (lockdown from PRs #300 + #301)
--   service_role:  full privileges (bypasses RLS; SECURITY DEFINER
--                  RPCs run as the function owner anyway)
--
-- Idempotent: REVOKE is a no-op when the privilege is absent. Safe
-- to re-run via `supabase db push --include-all`.

REVOKE INSERT, UPDATE, DELETE ON public.agents          FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.agent_versions  FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.agent_actions   FROM anon;

-- Sanity: confirm anon has no INSERT/UPDATE/DELETE left on any of
-- the three tables.
DO $$
DECLARE
  v_bad_count integer;
BEGIN
  SELECT count(*) INTO v_bad_count
    FROM information_schema.table_privileges
   WHERE grantee = 'anon'
     AND table_schema = 'public'
     AND table_name IN ('agents', 'agent_versions', 'agent_actions')
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');

  IF v_bad_count <> 0 THEN
    RAISE EXCEPTION
      'anon cleanup failed: anon still has % write privileges on agent-platform tables',
      v_bad_count;
  END IF;
END
$$;
