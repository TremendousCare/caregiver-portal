-- Rollback for 20260516010000_agent_platform_phase_1_6_1_call_taxonomy_table.sql
--
-- Drops the table; CASCADE clears its policies, indexes, trigger, and
-- the RPC's UPSERT target. Run AFTER rolling back the RPC migration
-- (20260516010001_*_down.sql) — otherwise the RPC silently fails on
-- next call.
--
-- If the seed migration (20260516010002) was applied, those rows are
-- inside the table and disappear with the DROP. There's no extra step
-- needed to clean up seed rows separately.

DROP TABLE IF EXISTS public.call_taxonomy CASCADE;
