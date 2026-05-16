-- Rollback for 20260516010001_agent_platform_phase_1_6_1_upsert_call_taxonomy_row_rpc.sql
--
-- Drops the RPC. Run BEFORE rolling back the table — otherwise the
-- function exists but its target table is gone (works for `DROP
-- FUNCTION` either way, but cleaner ordering).

DROP FUNCTION IF EXISTS public.upsert_call_taxonomy_row_v1(
  text, text, text, text, integer, boolean
);
