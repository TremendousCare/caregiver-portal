-- Phase 0.5 PR B — agent table write lockdown.
--
-- Closes the Phase 0.1 RLS gap that Codex flagged on PR #292: the
-- existing tenant_isolation_agents_{insert,update,delete} policies
-- gate on org_id only, so any authenticated same-org user could
-- bypass the SECURITY DEFINER RPCs and write to public.agents or
-- public.agent_versions directly. Locked per
-- `docs/AGENT_PLATFORM_PHASE_0_5_SPEC.md` §9 D11.
--
-- The fix: revoke INSERT/UPDATE/DELETE table-level privileges from
-- the `authenticated` role on both tables. SELECT stays — admins and
-- non-admins can still read rows under the existing org-scoped RLS
-- SELECT policies. The three SECURITY DEFINER RPCs introduced in
-- PR A and PR B (`toggle_agent_flag_v1`, `update_agent_manifest_v1`,
-- `revert_agent_to_version_v1`) run as the function owner (postgres),
-- which is unaffected by this REVOKE — they remain the *only*
-- legitimate write path. Each RPC enforces its own admin gate via
-- `public.is_admin()`.
--
-- Why revoke privileges and NOT admin-gate the RLS policies (the
-- alternative considered in §9 D11): the 2026-05-09 user_roles RLS
-- recursion incident (hotfixes #289 + #290) demonstrated empirically
-- that admin-gating RLS policies has a footgun pattern even with
-- SECURITY DEFINER helpers (chains two levels deep into the same
-- table can trip Postgres' policy recursion detector). Revoking
-- privileges keeps `agents` and `agent_versions` *out* of the
-- admin-gated RLS chain entirely, so as Phase 1+ ships more admin-
-- tier tables (agent_actions, etc.) we don't need to audit chain
-- depth.
--
-- Idempotency: REVOKE is a no-op if the privilege was already absent.
-- Safe to re-run via `supabase db push --include-all`.
--
-- Production impact: the moment this migration ships, any frontend
-- or service-role-impersonating code that does
-- `supabase.from('agents').update(...)` (or insert/delete) under an
-- authenticated session will fail with `permission denied for table
-- agents`. The `authenticated` REVOKE does NOT affect:
--   - service_role (bypasses RLS, has table privileges by default)
--   - postgres (function owner; SECURITY DEFINER RPCs run as this)
--   - SELECT statements from authenticated users
-- Audit before this PR ships: there are no production callers that
-- write directly to agents/agent_versions under the authenticated
-- role. The only writes today are PR A's toggle_agent_flag_v1 and
-- the agents/agent_versions seed (Phase 0.1 migration runs as
-- postgres). PR B adds two more SECURITY DEFINER RPCs. No frontend
-- code in src/ does direct UPDATE/INSERT/DELETE on either table.

REVOKE INSERT, UPDATE, DELETE ON public.agents          FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.agent_versions  FROM authenticated;

-- Sanity: confirm the REVOKE landed. We check for the absence of
-- INSERT/UPDATE/DELETE in pg_class.relacl-derived information_schema.
DO $$
DECLARE
  v_bad_count integer;
BEGIN
  SELECT count(*) INTO v_bad_count
    FROM information_schema.table_privileges
   WHERE grantee = 'authenticated'
     AND table_schema = 'public'
     AND table_name IN ('agents', 'agent_versions')
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');

  IF v_bad_count <> 0 THEN
    RAISE EXCEPTION
      'agent table lockdown failed: authenticated still has % write privileges on agents/agent_versions',
      v_bad_count;
  END IF;
END
$$;
