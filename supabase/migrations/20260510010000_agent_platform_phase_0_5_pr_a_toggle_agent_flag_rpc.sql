-- Phase 0.5 PR A — toggle_agent_flag_v1 RPC.
--
-- Lets an admin flip an agent's `kill_switch` or `shadow_mode` from the
-- Settings UI without touching `version` and without a deploy. Locked
-- per `docs/AGENT_PLATFORM_PHASE_0_5_SPEC.md` §9 D4 (no agent_versions
-- row on toggle), D5 (yes events row on toggle), D11 (RPC is the
-- recommended write path; PR B revokes direct table writes from
-- `authenticated` to make it the *enforced* sole path).
--
-- Behaviour:
--   * Admin-only — calls `public.is_admin()` (the SECURITY DEFINER
--     helper from hotfix #289 that avoids the user_roles RLS recursion
--     pattern). Non-admin authenticated users get 42501 permission
--     denied.
--   * Tenant isolation — JWT's `org_id` claim must match the agent's
--     `org_id`. Cross-org calls get 42501 even from admins.
--   * Validates `p_flag IN ('kill_switch', 'shadow_mode')`.
--   * Updates the column, sets `updated_by = 'user:<email>'`. The
--     `updated_at` trigger (`tg_agents_set_updated_at`) handles the
--     timestamp.
--   * Writes one `events` row per *real* state transition. If the
--     caller toggles to the value already in place, the UPDATE still
--     runs (cheap) but no audit row is written — the operator sees no
--     spurious history entries from idempotent retries.
--   * Returns the new value. Frontend uses this for optimistic
--     reconciliation if it ever doubts its local state.
--
-- Recursion safety: this function is SECURITY DEFINER, calls
-- `is_admin()` which is also SECURITY DEFINER. Both bypass RLS for
-- their inner SELECTs, so no policy on `user_roles` or `agents` is
-- evaluated during the admin check. The user_roles RLS recursion
-- pattern (hotfixes #289 + #290) cannot apply here because no policy
-- on `agents`/`agent_versions`/`user_roles` references this RPC.
--
-- entity_type / entity_id: the `events` table has a CHECK constraint
-- restricting entity_type to ('caregiver', 'client'). Agent-scoped
-- events use entity_type=NULL, entity_id=NULL — the `agent_id` column
-- (added in Phase 0.2) is the canonical reference for agent events.
--
-- Granted to `authenticated` so the Settings UI can call it; the
-- admin gate inside is what restricts the call.

CREATE OR REPLACE FUNCTION public.toggle_agent_flag_v1(
  p_agent_id uuid,
  p_flag     text,
  p_value    boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_email text;
  v_jwt_org_id  uuid;
  v_agent       record;
  v_prior_value boolean;
  v_actor       text;
BEGIN
  -- 1. Admin-only.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'permission denied: not an admin' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate flag name.
  IF p_flag NOT IN ('kill_switch', 'shadow_mode') THEN
    RAISE EXCEPTION 'invalid flag: %', p_flag USING ERRCODE = '22023';
  END IF;

  -- 3. Resolve the caller's org from the JWT.
  v_jwt_org_id := nullif(auth.jwt() ->> 'org_id', '')::uuid;
  IF v_jwt_org_id IS NULL THEN
    RAISE EXCEPTION 'JWT missing org_id claim' USING ERRCODE = '42501';
  END IF;

  -- 4. Load the agent and verify cross-org access is blocked. We take
  --    a row-level lock (FOR UPDATE) during the initial read so that
  --    concurrent toggles on the same agent serialize. Without the
  --    lock, two near-simultaneous toggle calls (e.g. from two admin
  --    sessions or from a frontend retry race) could both read the
  --    same prior value, both pass the v_prior_value IS DISTINCT FROM
  --    p_value check below, and write duplicate `agent_flag_toggled`
  --    audit rows even though only the first call caused a real
  --    transition. The lock funnels them: the second waits for the
  --    first to commit, then sees the post-first-call state and
  --    correctly classifies its own toggle as a no-op.
  SELECT a.id, a.org_id, a.kill_switch, a.shadow_mode INTO v_agent
    FROM public.agents a
   WHERE a.id = p_agent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent not found: %', p_agent_id USING ERRCODE = 'P0002';
  END IF;
  IF v_agent.org_id <> v_jwt_org_id THEN
    RAISE EXCEPTION 'permission denied: agent org mismatch' USING ERRCODE = '42501';
  END IF;

  -- 5. Capture prior value, perform the update.
  v_actor_email := lower((auth.jwt() ->> 'email'));
  v_actor       := 'user:' || coalesce(v_actor_email, 'unknown');

  IF p_flag = 'kill_switch' THEN
    v_prior_value := v_agent.kill_switch;
    UPDATE public.agents
       SET kill_switch = p_value,
           updated_by  = v_actor
     WHERE id = p_agent_id;
  ELSE  -- 'shadow_mode'
    v_prior_value := v_agent.shadow_mode;
    UPDATE public.agents
       SET shadow_mode = p_value,
           updated_by  = v_actor
     WHERE id = p_agent_id;
  END IF;

  -- 6. Audit row in events. Stamped with agent_id per Phase 0.4
  --    contract; entity_type/id NULL because the events.entity_type
  --    CHECK only allows caregiver/client. Skipped on no-op transitions
  --    so idempotent retries don't churn the audit trail.
  IF v_prior_value IS DISTINCT FROM p_value THEN
    INSERT INTO public.events (
      org_id, agent_id, event_type, entity_type, entity_id, actor, payload
    ) VALUES (
      v_jwt_org_id,
      p_agent_id,
      'agent_flag_toggled',
      NULL,
      NULL,
      v_actor,
      jsonb_build_object(
        'flag',        p_flag,
        'prior_value', v_prior_value,
        'new_value',   p_value
      )
    );
  END IF;

  RETURN p_value;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.toggle_agent_flag_v1(uuid, text, boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.toggle_agent_flag_v1(uuid, text, boolean) TO authenticated;

-- Sanity check: confirm the function landed and is SECURITY DEFINER.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'toggle_agent_flag_v1'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'public.toggle_agent_flag_v1 missing or not SECURITY DEFINER after migration';
  END IF;
END
$$;
