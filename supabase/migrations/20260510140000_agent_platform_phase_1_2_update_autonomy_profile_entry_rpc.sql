-- Phase 1.2 — atomic autonomy_profile entry update RPC.
--
-- Codex P2 (#r3214228075): the v2 wrapper `recordAutonomyOutcomeV2`
-- originally did a read-modify-write on the whole `autonomy_profile`
-- jsonb. Two concurrent outcomes for the same agent (different action
-- types, or one racing an admin edit) both read the snapshot, mutate one
-- key, and write the entire object back — second write drops the first.
--
-- This RPC replaces that pattern with a single `jsonb_set` UPDATE that:
--   * Atomically merges `p_entry` under the `[p_action_type]` key in
--     `autonomy_profile` — concurrent calls for *different* action_types
--     no longer race each other (each merges independently).
--   * Holds an implicit row-level lock for the duration of the UPDATE,
--     serializing concurrent calls for the *same* action_type. Last
--     write still wins for the same key, but the verdict is roughly
--     idempotent (both calls see the same metrics window) so this is
--     tolerable. If we ever need stronger semantics, a `FOR UPDATE`
--     SELECT before the UPDATE would block the second caller until the
--     first commits.
--
-- Service-role-grant only — same posture as `record_agent_action_v1`
-- (Phase 1.1.A). The runtime calls this from the edge functions using
-- the service role key. `authenticated` is REVOKE'd because admins edit
-- the profile through `update_agent_manifest_v1`, not this function.
--
-- Does NOT bump `agents.version`. Operational autonomy bookkeeping is
-- not a manifest edit and does not belong in `agent_versions` history.
-- (The `events` row written alongside the call by the edge function is
-- the audit trail for autonomy promotions/demotions.)

CREATE OR REPLACE FUNCTION public.update_autonomy_profile_entry_v1(
  p_agent_id     uuid,
  p_action_type  text,
  p_entry        jsonb,
  p_updated_by   text DEFAULT 'system:autonomy_v2'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_profile jsonb;
BEGIN
  -- Validate inputs. Reject obviously-bad payloads early so callers get
  -- a structured error rather than silently writing nonsense into a
  -- production agents row.
  IF p_agent_id IS NULL THEN
    RAISE EXCEPTION 'p_agent_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_action_type IS NULL OR length(p_action_type) = 0 THEN
    RAISE EXCEPTION 'p_action_type is required' USING ERRCODE = '22023';
  END IF;
  IF p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
    RAISE EXCEPTION 'p_entry must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_updated_by IS NULL OR length(p_updated_by) = 0 THEN
    RAISE EXCEPTION 'p_updated_by is required' USING ERRCODE = '22023';
  END IF;

  -- Atomic single-key UPDATE. `jsonb_set` with create_missing=true
  -- (default) handles both initial creation of the key and overwrite of
  -- an existing key. The COALESCE covers the (unlikely) case where
  -- autonomy_profile is NULL on a freshly seeded agent — jsonb_set on
  -- NULL returns NULL, which would silently wipe the row.
  --
  -- The implicit row-level lock that an UPDATE acquires is what
  -- serializes concurrent calls for the same agent_id. Inter-action
  -- races resolve correctly because each call mutates its own key path.
  UPDATE public.agents
     SET autonomy_profile = jsonb_set(
           COALESCE(autonomy_profile, '{}'::jsonb),
           ARRAY[p_action_type],
           p_entry,
           true
         ),
         updated_by = p_updated_by
   WHERE id = p_agent_id
   RETURNING autonomy_profile INTO v_new_profile;

  IF v_new_profile IS NULL THEN
    RAISE EXCEPTION 'agent not found: %', p_agent_id USING ERRCODE = 'P0002';
  END IF;

  RETURN v_new_profile;
END;
$$;

REVOKE ALL ON FUNCTION public.update_autonomy_profile_entry_v1(uuid, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_autonomy_profile_entry_v1(uuid, text, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_autonomy_profile_entry_v1(uuid, text, jsonb, text) TO service_role;

COMMENT ON FUNCTION public.update_autonomy_profile_entry_v1(uuid, text, jsonb, text) IS
  'Phase 1.2: atomic single-action-key update on agents.autonomy_profile. '
  'Service-role only. Used by recordAutonomyOutcomeV2 to avoid the '
  'read-modify-write race that would drop concurrent profile changes '
  '(Codex P2 #r3214228075).';
