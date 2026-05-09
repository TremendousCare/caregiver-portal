-- Phase 0.5 PR B — revert_agent_to_version_v1 RPC.
--
-- Restore an agent's editable manifest fields to a prior version's
-- snapshot, creating a new (current+1) version with the reverted
-- content. The historical agent_versions row at p_target_version is
-- never edited or deleted; the audit trail stays append-only.
--
-- Locked per `docs/AGENT_PLATFORM_PHASE_0_5_SPEC.md` §3.5.
--
-- Excluded fields (revert does NOT change these even if the
-- historical snapshot has a different value):
--   - id, org_id, slug, created_at, created_by — identity / lineage
--   - kill_switch, shadow_mode — operational levers, not manifest
--     content (toggles via toggle_agent_flag_v1 only)
--   - version, updated_at, updated_by — managed here
--   - triggers — read-only forever per spec §2 (cron coupling)
--
-- Same security posture as update_agent_manifest_v1: admin-only,
-- tenant-isolated, FOR UPDATE row lock, change_summary required.
-- No optimistic version check — revert is naturally idempotent
-- (reverting twice produces two snapshots both matching the target),
-- and racing two reverts on the same row is benign because the lock
-- serializes them.

CREATE OR REPLACE FUNCTION public.revert_agent_to_version_v1(
  p_agent_id        uuid,
  p_target_version  integer,
  p_change_summary  text
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
  v_target_row  public.agent_versions%ROWTYPE;
  v_target_snap jsonb;
  v_new_version integer;
  v_new_row     public.agents%ROWTYPE;
  v_new_snap    jsonb;
BEGIN
  -- 1. Admin-only.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied: not an admin' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate.
  IF p_change_summary IS NULL OR length(trim(p_change_summary)) = 0 THEN
    RAISE EXCEPTION 'change_summary is required' USING ERRCODE = '22023';
  END IF;
  IF p_target_version IS NULL OR p_target_version < 1 THEN
    RAISE EXCEPTION 'target_version must be >= 1' USING ERRCODE = '22023';
  END IF;

  -- 3. Resolve org from JWT.
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

  -- 5. Refusing to "revert to current" — no-op-but-version-bump is
  --    confusing in the UI. The frontend disables the Revert button on
  --    the current row, but defense in depth.
  IF p_target_version = v_agent.version THEN
    RAISE EXCEPTION 'target_version equals current version (no-op revert blocked)'
      USING ERRCODE = '22023';
  END IF;

  -- 6. Load target snapshot.
  SELECT * INTO v_target_row
    FROM public.agent_versions
   WHERE agent_id = p_agent_id AND version = p_target_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target version % not found for agent %',
      p_target_version, p_agent_id USING ERRCODE = 'P0002';
  END IF;
  v_target_snap := v_target_row.snapshot;

  v_new_version := v_agent.version + 1;

  -- 7. Apply target snapshot's editable fields onto current row.
  --    Excluded fields stay at their current values. The snapshot's
  --    own version/updated_* fields are deliberately ignored — we set
  --    them ourselves below.
  UPDATE public.agents
     SET
       name              = COALESCE(v_target_snap->>'name', name),
       system_prompt     = COALESCE(v_target_snap->>'system_prompt', system_prompt),
       tool_allowlist    = CASE
                              WHEN v_target_snap ? 'tool_allowlist' AND jsonb_typeof(v_target_snap->'tool_allowlist') = 'array'
                              THEN ARRAY(
                                SELECT jsonb_array_elements_text(v_target_snap->'tool_allowlist')
                              )
                              ELSE tool_allowlist
                            END,
       autonomy_profile  = COALESCE(v_target_snap->'autonomy_profile', autonomy_profile),
       context_recipe    = COALESCE(v_target_snap->'context_recipe', context_recipe),
       model             = COALESCE(v_target_snap->>'model', model),
       max_iterations    = COALESCE((v_target_snap->>'max_iterations')::integer, max_iterations),
       outcome_definition = COALESCE(v_target_snap->'outcome_definition', outcome_definition),
       version    = v_new_version,
       updated_by = v_actor
   WHERE id = p_agent_id
   RETURNING * INTO v_new_row;

  -- 8. Snapshot the post-revert row into agent_versions.
  v_new_snap := to_jsonb(v_new_row) - 'created_at' - 'updated_at';

  INSERT INTO public.agent_versions (
    org_id, agent_id, agent_slug, version, snapshot, change_summary, changed_by
  ) VALUES (
    v_new_row.org_id,
    v_new_row.id,
    v_new_row.slug,
    v_new_version,
    v_new_snap,
    p_change_summary,
    v_actor
  );

  RETURN v_new_version;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revert_agent_to_version_v1(uuid, integer, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.revert_agent_to_version_v1(uuid, integer, text) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'revert_agent_to_version_v1'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'public.revert_agent_to_version_v1 missing or not SECURITY DEFINER after migration';
  END IF;
END
$$;
