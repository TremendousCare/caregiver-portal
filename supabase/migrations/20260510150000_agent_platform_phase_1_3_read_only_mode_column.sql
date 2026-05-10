-- Phase 1.3 — read_only_mode column on agents.
--
-- Adds a third runtime safety flag alongside `kill_switch` and
-- `shadow_mode`. Semantics:
--
--   kill_switch=true       → Agent does NOT run. runAgent returns
--                            immediately with status='killed'. No
--                            Claude call, no tool calls, no writes.
--   shadow_mode=true       → Agent runs, but confirm-tier tool calls
--                            are routed to ai_suggestions with
--                            status='shadow' instead of executing.
--                            Auto-tier (read-only) tools still execute.
--                            Existing 0.3+ behaviour.
--   read_only_mode=true    → Agent runs, but ALL tool calls (auto AND
--                            confirm) return a synthetic "tool
--                            suppressed" result. The agent must reply
--                            from prior context only — no DB reads, no
--                            DB writes, no ai_suggestions rows. Useful
--                            for privacy mode, debugging without side
--                            effects, or running against historical
--                            context only.
--
-- Precedence (when multiple flags are on):
--   kill_switch > read_only_mode > shadow_mode
-- The runtime checks kill_switch first; if read_only_mode is also on,
-- shadow_mode's wrapping is irrelevant (no tool ever runs anyway).
--
-- Defaults to false so production behaviour is unchanged. Live agents
-- get this column set to false on their existing rows; new agents in
-- future seeds inherit false.
--
-- Phase 1.3 also extends `toggle_agent_flag_v1` to accept the new
-- `'read_only_mode'` flag value (separate migration in this PR).
--
-- Safety:
--   * ADD COLUMN IF NOT EXISTS — idempotent.
--   * NOT NULL DEFAULT false — old code that doesn't read the column is
--     unaffected; new code can rely on the value being non-null.
--   * No DROP, no DELETE, no destructive change.

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS read_only_mode boolean NOT NULL DEFAULT false;

-- Mirror on agent_versions snapshots so future
-- `update_agent_manifest_v1` / `revert_agent_to_version_v1` calls round-
-- trip the new flag correctly. The snapshot column is jsonb, so this is
-- handled at the application layer, not the schema — but we capture the
-- intent here for future contributors.
COMMENT ON COLUMN public.agents.read_only_mode IS
  'Phase 1.3: when true, all tool calls (read AND write) return a synthetic '
  '"tool suppressed" result. Agent runs and replies from prior context only. '
  'Distinct from shadow_mode (which only suppresses confirm-tier writes) and '
  'kill_switch (which prevents the agent from running at all). Default false.';

-- Smoke: confirm column landed with the right type + default.
DO $$
DECLARE
  v_col record;
BEGIN
  SELECT column_name, data_type, is_nullable, column_default
    INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'agents'
     AND column_name  = 'read_only_mode';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phase 1.3: agents.read_only_mode missing after migration';
  END IF;
  IF v_col.data_type <> 'boolean' THEN
    RAISE EXCEPTION 'Phase 1.3: agents.read_only_mode wrong type: % (expected boolean)', v_col.data_type;
  END IF;
  IF v_col.is_nullable <> 'NO' THEN
    RAISE EXCEPTION 'Phase 1.3: agents.read_only_mode must be NOT NULL';
  END IF;
  IF v_col.column_default IS NULL OR v_col.column_default NOT LIKE 'false%' THEN
    RAISE EXCEPTION 'Phase 1.3: agents.read_only_mode default must be false (got %)', v_col.column_default;
  END IF;
END
$$;
