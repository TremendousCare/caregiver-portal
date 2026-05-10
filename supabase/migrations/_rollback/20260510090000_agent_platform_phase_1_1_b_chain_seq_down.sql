-- Rollback for the chain_seq fix.
-- Drops the column + index. The RPC stays at the chain_seq variant
-- (CREATE OR REPLACE replaced it idempotently on apply); rolling
-- back the function definition without rolling back the column
-- would leave the function reading a non-existent column. Order
-- matters: drop function variant first, then column.

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
  p_created_at          timestamptz,
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
  -- Pre-PR-1.1.B-chain_seq function body: ORDER BY created_at DESC, id DESC.
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
    RAISE EXCEPTION 'row_hash, signature, and claimed_prev_hash are required' USING ERRCODE = '22023';
  END IF;
  IF p_created_at IS NULL THEN
    RAISE EXCEPTION 'p_created_at is required (must equal the timestamp used to compute row_hash)'
      USING ERRCODE = '22023';
  END IF;
  IF abs(extract(epoch from (now() - p_created_at))) > 300 THEN
    RAISE EXCEPTION 'p_created_at out of range (>5 min from server now())'
      USING ERRCODE = '22023';
  END IF;
  v_jwt_org_id := nullif(auth.jwt() ->> 'org_id', '')::uuid;
  IF v_jwt_org_id IS NOT NULL AND v_jwt_org_id <> p_org_id THEN
    RAISE EXCEPTION 'permission denied: JWT org_id does not match p_org_id'
      USING ERRCODE = '42501';
  END IF;
  v_lock_key := hashtext(p_org_id::text);
  PERFORM pg_advisory_xact_lock(v_lock_key);
  SELECT row_hash INTO v_actual_prev
    FROM public.agent_actions
   WHERE org_id = p_org_id
   ORDER BY created_at DESC, id DESC
   LIMIT 1;
  IF v_actual_prev IS NULL THEN
    v_actual_prev := '';
  END IF;
  IF v_actual_prev <> p_claimed_prev_hash THEN
    RAISE EXCEPTION
      'agent_actions_chain_conflict: claimed prev_hash % does not match actual %',
      p_claimed_prev_hash, v_actual_prev
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.agent_actions (
    org_id, agent_id, agent_version, action_type, phase,
    entity_type, entity_id, actor, payload, outcome_id,
    created_at, prev_hash, row_hash, signature
  ) VALUES (
    p_org_id, p_agent_id, p_agent_version, p_action_type, p_phase,
    p_entity_type, p_entity_id, p_actor, COALESCE(p_payload, '{}'::jsonb), p_outcome_id,
    p_created_at, p_claimed_prev_hash, p_row_hash, p_signature
  )
  RETURNING id INTO v_inserted_id;
  RETURN v_inserted_id;
END;
$$;

DROP INDEX IF EXISTS public.idx_agent_actions_org_chain_seq;
ALTER TABLE public.agent_actions DROP CONSTRAINT IF EXISTS agent_actions_chain_seq_unique;
ALTER TABLE public.agent_actions DROP COLUMN IF EXISTS chain_seq;
