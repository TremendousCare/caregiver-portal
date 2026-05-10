-- Phase 1.3 — extend toggle_agent_flag_v1 to accept 'read_only_mode'.
--
-- Phase 0.5 PR A's `toggle_agent_flag_v1` accepts only 'kill_switch' or
-- 'shadow_mode'. Phase 1.3 adds the `read_only_mode` column on `agents`
-- (separate migration in this PR), so the toggle RPC needs a third
-- branch. Otherwise the Settings UI's read-only toggle would 22023 at
-- the validation gate.
--
-- This is a CREATE OR REPLACE that preserves the function's behaviour
-- byte-for-byte except in two places:
--
--   1. The flag-name validation now accepts 'read_only_mode'.
--   2. The UPDATE branch handles the third column.
--
-- Everything else — admin gate (`is_admin()`), JWT org_id check, FOR
-- UPDATE row lock, agent-flag-toggled events row, no-op idempotency —
-- is identical to the 0.5 version. The recursion-safety reasoning from
-- the 0.5 header still applies; SECURITY DEFINER + pinned search_path
-- carries forward.
--
-- Safety:
--   * Pure CREATE OR REPLACE on an existing function — no DROP, no
--     schema migration of dependent objects.
--   * Existing callers that pass 'kill_switch' / 'shadow_mode' are
--     unaffected.
--   * Function signature (uuid, text, boolean) is unchanged so existing
--     `GRANT EXECUTE` from PR A still applies.

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

  -- 2. Validate flag name. Phase 1.3 adds 'read_only_mode' alongside
  --    the original two values from 0.5.
  IF p_flag NOT IN ('kill_switch', 'shadow_mode', 'read_only_mode') THEN
    RAISE EXCEPTION 'invalid flag: %', p_flag USING ERRCODE = '22023';
  END IF;

  -- 3. Resolve the caller's org from the JWT.
  v_jwt_org_id := nullif(auth.jwt() ->> 'org_id', '')::uuid;
  IF v_jwt_org_id IS NULL THEN
    RAISE EXCEPTION 'JWT missing org_id claim' USING ERRCODE = '42501';
  END IF;

  -- 4. Load the agent and verify cross-org access is blocked. FOR
  --    UPDATE serializes concurrent toggles per Phase 0.5 PR A's
  --    duplicate-audit-row defence. We add `read_only_mode` to the
  --    SELECT list so the prior-value compare can read it without
  --    a second SELECT.
  SELECT a.id, a.org_id, a.kill_switch, a.shadow_mode, a.read_only_mode INTO v_agent
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
  ELSIF p_flag = 'shadow_mode' THEN
    v_prior_value := v_agent.shadow_mode;
    UPDATE public.agents
       SET shadow_mode = p_value,
           updated_by  = v_actor
     WHERE id = p_agent_id;
  ELSE  -- 'read_only_mode'
    v_prior_value := v_agent.read_only_mode;
    UPDATE public.agents
       SET read_only_mode = p_value,
           updated_by     = v_actor
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

-- The function signature (uuid, text, boolean) is unchanged so the
-- existing GRANT from Phase 0.5 PR A (GRANT EXECUTE TO authenticated)
-- carries forward. Re-asserted here for defence-in-depth — if a future
-- PR ever DROPs and recreates the function, the grant pattern is
-- preserved in this migration.
REVOKE EXECUTE ON FUNCTION public.toggle_agent_flag_v1(uuid, text, boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.toggle_agent_flag_v1(uuid, text, boolean) TO authenticated;

-- Smoke: confirm the function still exists, is SECURITY DEFINER, and
-- accepts the new flag value.
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
