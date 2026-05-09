-- Phase 0.5 PR B — update_agent_manifest_v1 RPC.
--
-- Editable manifest save endpoint. Called from the Settings UI's
-- SaveConfirmationDialog after the admin reviews the diff. Locked per
-- `docs/AGENT_PLATFORM_PHASE_0_5_SPEC.md` §3.3 and §3.4.
--
-- Behaviour:
--   * Admin-only via `public.is_admin()`. Same recursion-safe helper
--     used by toggle_agent_flag_v1 (PR A).
--   * Tenant-isolated: JWT org_id must match the agent's org_id.
--   * Optimistic lock: takes p_expected_version; if agents.version has
--     advanced past it (another admin saved first), raises
--     `agent_version_conflict` (sqlstate P0001) so the UI can prompt
--     a reload-and-retry. Locked spec §9 D3.
--   * FOR UPDATE row lock during the read so two admins arriving at the
--     same instant serialize cleanly (mirror of the PR A pattern; the
--     version check is the user-visible conflict surface, the lock is
--     the implementation detail that makes the check race-free).
--   * Applies updates from p_updates jsonb. Only an explicit allowlist
--     of keys is honored — anything else is silently dropped. This is
--     defense in depth: the UI sends only allowlisted fields, but the
--     RPC enforces it so direct callers can't sneak through extra
--     mutations like flipping kill_switch via this path.
--   * Allowlisted editable fields:
--       name, system_prompt, tool_allowlist, autonomy_profile,
--       context_recipe, model, max_iterations, outcome_definition
--     Operational levers (kill_switch, shadow_mode) and identity
--     fields (id, org_id, slug, created_*, updated_*, version, triggers)
--     are NOT editable here. Triggers stays read-only forever per spec
--     §2 — cron schedule changes need a separate redeploy story.
--   * Increments version, updates updated_by, writes one agent_versions
--     row with the post-edit snapshot. The seed convention (Phase 0.1)
--     is that snapshot N reflects state-at-version-N; we honor that
--     here by computing the snapshot from the freshly-updated row.
--   * change_summary is required (nonempty) so the version history is
--     readable. UI defaults it to a reasonable string but admins can
--     override.
--   * Returns the new version number for optimistic UI reconciliation.
--
-- Recursion safety: same posture as toggle_agent_flag_v1 — calls
-- public.is_admin() (SECURITY DEFINER, bypasses RLS for its inner
-- SELECT). No policy on agents/agent_versions/user_roles references
-- this RPC, so the user_roles RLS recursion pattern (hotfixes #289 +
-- #290) cannot apply.
--
-- Granted to authenticated; admin gate inside is what restricts use.
-- After the lockdown migration (separate file in this PR) revokes
-- direct writes from authenticated, this RPC is the *enforced* sole
-- write path for manifest fields.

CREATE OR REPLACE FUNCTION public.update_agent_manifest_v1(
  p_agent_id          uuid,
  p_expected_version  integer,
  p_updates           jsonb,
  p_change_summary    text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_email text;
  v_actor       text;
  v_jwt_org_id  uuid;
  v_agent       public.agents%ROWTYPE;
  v_new_version integer;
  v_new_row     public.agents%ROWTYPE;
  v_snapshot    jsonb;
BEGIN
  -- 1. Admin-only.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied: not an admin' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate input shapes.
  IF p_change_summary IS NULL OR length(trim(p_change_summary)) = 0 THEN
    RAISE EXCEPTION 'change_summary is required' USING ERRCODE = '22023';
  END IF;
  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'object' THEN
    RAISE EXCEPTION 'updates must be a jsonb object' USING ERRCODE = '22023';
  END IF;

  -- 3. Resolve caller's org from the JWT.
  v_jwt_org_id := nullif(auth.jwt() ->> 'org_id', '')::uuid;
  IF v_jwt_org_id IS NULL THEN
    RAISE EXCEPTION 'JWT missing org_id claim' USING ERRCODE = '42501';
  END IF;

  v_actor_email := lower((auth.jwt() ->> 'email'));
  v_actor       := 'user:' || coalesce(v_actor_email, 'unknown');

  -- 4. Load agent under row lock.
  SELECT * INTO v_agent
    FROM public.agents
   WHERE id = p_agent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent not found: %', p_agent_id USING ERRCODE = 'P0002';
  END IF;
  IF v_agent.org_id <> v_jwt_org_id THEN
    RAISE EXCEPTION 'permission denied: agent org mismatch' USING ERRCODE = '42501';
  END IF;

  -- 5. Optimistic version check. If another admin saved between when
  --    the UI loaded the manifest and when it called this RPC, raise
  --    P0001 so the UI shows the reload-and-retry dialog.
  IF v_agent.version <> p_expected_version THEN
    RAISE EXCEPTION 'agent_version_conflict: expected version %, found %',
      p_expected_version, v_agent.version
      USING ERRCODE = 'P0001';
  END IF;

  v_new_version := v_agent.version + 1;

  -- 6. Apply allowlisted updates. Only the eight editable manifest
  --    fields are honored. Others (kill_switch, shadow_mode, slug,
  --    triggers, etc.) are silently ignored.
  --
  --    For text/integer fields: COALESCE keeps the old value when the
  --    key is absent from p_updates, but explicitly accepts NULL? No —
  --    the agents table CHECKs require nonempty for several fields, so
  --    we use a guard: if the key is present we update; if absent we
  --    keep the prior value.
  --
  --    Implementation note: jsonb's `?` operator tests key presence
  --    (excluding NULL JSON values), and `->>` returns text or NULL.
  --    We branch per-field for clarity instead of dynamic SQL.
  UPDATE public.agents
     SET
       name              = CASE WHEN p_updates ? 'name'
                              THEN p_updates->>'name'
                              ELSE name END,
       system_prompt     = CASE WHEN p_updates ? 'system_prompt'
                              THEN p_updates->>'system_prompt'
                              ELSE system_prompt END,
       tool_allowlist    = CASE WHEN p_updates ? 'tool_allowlist'
                              THEN ARRAY(
                                SELECT jsonb_array_elements_text(p_updates->'tool_allowlist')
                              )
                              ELSE tool_allowlist END,
       autonomy_profile  = CASE WHEN p_updates ? 'autonomy_profile'
                              THEN p_updates->'autonomy_profile'
                              ELSE autonomy_profile END,
       context_recipe    = CASE WHEN p_updates ? 'context_recipe'
                              THEN p_updates->'context_recipe'
                              ELSE context_recipe END,
       model             = CASE WHEN p_updates ? 'model'
                              THEN p_updates->>'model'
                              ELSE model END,
       max_iterations    = CASE WHEN p_updates ? 'max_iterations'
                              THEN (p_updates->>'max_iterations')::integer
                              ELSE max_iterations END,
       outcome_definition = CASE WHEN p_updates ? 'outcome_definition'
                              THEN p_updates->'outcome_definition'
                              ELSE outcome_definition END,
       version    = v_new_version,
       updated_by = v_actor
   WHERE id = p_agent_id
   RETURNING * INTO v_new_row;

  -- 7. Snapshot the post-edit row into agent_versions. Mirror the
  --    seed convention: subtract created_at/updated_at so the
  --    snapshot reflects the manifest content, not transient
  --    timestamps. (Other fields like updated_by are kept — useful
  --    for forensics.)
  v_snapshot := to_jsonb(v_new_row) - 'created_at' - 'updated_at';

  INSERT INTO public.agent_versions (
    org_id, agent_id, agent_slug, version, snapshot, change_summary, changed_by
  ) VALUES (
    v_new_row.org_id,
    v_new_row.id,
    v_new_row.slug,
    v_new_version,
    v_snapshot,
    p_change_summary,
    v_actor
  );

  RETURN v_new_version;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_agent_manifest_v1(uuid, integer, jsonb, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.update_agent_manifest_v1(uuid, integer, jsonb, text) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'update_agent_manifest_v1'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'public.update_agent_manifest_v1 missing or not SECURITY DEFINER after migration';
  END IF;
END
$$;
