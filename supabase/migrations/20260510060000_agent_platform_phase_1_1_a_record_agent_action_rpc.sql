-- Phase 1.1.A — record_agent_action_v1 RPC.
--
-- Sole write path for the agent_actions table. The caller (the
-- recordAgentAction helper in _shared/operations/agentActions.ts)
-- has already:
--   1. Read the latest row's row_hash for this org (claimed_prev_hash).
--   2. Computed the candidate row_hash by hashing the chain inputs.
--   3. Signed row_hash with the per-org Ed25519 signing key.
-- This RPC verifies the chain link is still valid (no row landed
-- between the caller's read and the caller's write — the classic
-- TOCTOU window) under a row-level lock, then INSERTs.
--
-- Race semantics:
--   - The function takes a per-org advisory lock keyed by org_id
--     (hashed to bigint). This serializes all chain writes for the
--     org. Throughput-bounded but our throughput is tens of writes
--     per minute at peak — fine.
--   - Inside the lock, re-read the latest row_hash. If it differs
--     from p_claimed_prev_hash, the caller raced and we raise
--     `agent_actions_chain_conflict` (sqlstate P0001). The caller
--     re-reads, recomputes, re-signs, and retries.
--
-- Why advisory lock vs FOR UPDATE: the chain doesn't have a stable
-- "last row" identifier we can lock on (the latest row IS what we'd
-- be selecting). Advisory lock per org is the cleanest way to make
-- the read-then-insert atomic.
--
-- Granted to authenticated AND service_role: the runtime calls this
-- in two contexts. Most callers (chat shell, planner, router) run
-- with service_role. The Settings UI's toggle path (PR 1.1.B will
-- wire this) runs with the user's authenticated JWT — but only
-- after toggle_agent_flag_v1 (admin-gated SECURITY DEFINER) has
-- already validated the caller. So this RPC's own admin gate would
-- be redundant. It does, however, verify org_id consistency
-- between the JWT (when present) and the agent.

CREATE OR REPLACE FUNCTION public.record_agent_action_v1(
  p_org_id              uuid,
  p_agent_id            uuid,
  p_agent_version       integer,
  p_action_type         text,
  p_phase               text,
  p_entity_type         text,
  p_entity_id           uuid,
  p_actor               text,
  p_payload             jsonb,
  p_outcome_id          uuid,
  p_claimed_prev_hash   text,
  p_row_hash            text,
  p_signature           text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_org_id     uuid;
  v_actual_prev    text;
  v_inserted_id    uuid;
  v_lock_key       bigint;
BEGIN
  -- 1. Validate inputs the table CHECKs would catch anyway, but
  --    surface as 22023 for cleaner caller-side error handling.
  IF p_org_id IS NULL OR p_agent_id IS NULL THEN
    RAISE EXCEPTION 'org_id and agent_id are required' USING ERRCODE = '22023';
  END IF;
  IF p_phase NOT IN ('suggested', 'confirmed', 'executed', 'auto_executed', 'rejected', 'expired', 'shadow') THEN
    RAISE EXCEPTION 'invalid phase: %', p_phase USING ERRCODE = '22023';
  END IF;
  IF p_action_type IS NULL OR length(p_action_type) = 0 THEN
    RAISE EXCEPTION 'action_type required' USING ERRCODE = '22023';
  END IF;
  IF p_row_hash IS NULL OR length(p_row_hash) = 0
     OR p_signature IS NULL OR length(p_signature) = 0
     OR p_claimed_prev_hash IS NULL THEN
    -- claimed_prev_hash may be empty string (genesis row) but not NULL.
    RAISE EXCEPTION 'row_hash, signature, and claimed_prev_hash are required' USING ERRCODE = '22023';
  END IF;

  -- 2. Tenant isolation. When a JWT is present (authenticated path),
  --    the JWT's org_id must match p_org_id. service_role calls have
  --    no JWT; we trust the runtime to pass the right org.
  v_jwt_org_id := nullif(auth.jwt() ->> 'org_id', '')::uuid;
  IF v_jwt_org_id IS NOT NULL AND v_jwt_org_id <> p_org_id THEN
    RAISE EXCEPTION 'permission denied: JWT org_id does not match p_org_id'
      USING ERRCODE = '42501';
  END IF;

  -- 3. Take a per-org advisory lock. Hash org_id into a bigint
  --    using the postgres hashtext() over the uuid's text form.
  --    Held until the transaction commits, so all chain writes for
  --    this org serialize.
  v_lock_key := hashtext(p_org_id::text);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- 4. Re-read the latest row_hash for this org under the lock. If
  --    no rows yet, treat the chain as starting from '' (genesis).
  SELECT row_hash INTO v_actual_prev
    FROM public.agent_actions
   WHERE org_id = p_org_id
   ORDER BY created_at DESC, id DESC
   LIMIT 1;
  IF v_actual_prev IS NULL THEN
    v_actual_prev := '';  -- genesis
  END IF;

  -- 5. Verify the chain link. If another row landed between when
  --    the caller computed its hash and now, fail with a conflict
  --    so the caller retries with the fresh prev_hash.
  IF v_actual_prev <> p_claimed_prev_hash THEN
    RAISE EXCEPTION
      'agent_actions_chain_conflict: claimed prev_hash % does not match actual %',
      p_claimed_prev_hash, v_actual_prev
      USING ERRCODE = 'P0001';
  END IF;

  -- 6. Insert. The advisory lock prevents another writer from
  --    racing past this point with the same prev_hash.
  INSERT INTO public.agent_actions (
    org_id, agent_id, agent_version, action_type, phase,
    entity_type, entity_id, actor, payload, outcome_id,
    prev_hash, row_hash, signature
  ) VALUES (
    p_org_id, p_agent_id, p_agent_version, p_action_type, p_phase,
    p_entity_type, p_entity_id, p_actor, COALESCE(p_payload, '{}'::jsonb), p_outcome_id,
    p_claimed_prev_hash, p_row_hash, p_signature
  )
  RETURNING id INTO v_inserted_id;

  RETURN v_inserted_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_agent_action_v1(
  uuid, uuid, integer, text, text, text, uuid, text, jsonb, uuid, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_agent_action_v1(
  uuid, uuid, integer, text, text, text, uuid, text, jsonb, uuid, text, text, text
) TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'record_agent_action_v1'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'public.record_agent_action_v1 missing or not SECURITY DEFINER after migration';
  END IF;
END
$$;
