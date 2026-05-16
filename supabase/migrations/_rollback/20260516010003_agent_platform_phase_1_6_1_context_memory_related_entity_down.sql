-- Rollback for 20260516010003_agent_platform_phase_1_6_1_context_memory_related_entity.sql
--
-- Drops the two additive columns + their indexes + the CHECK
-- constraint. Pure additive in the forward direction, so the rollback
-- is also clean.
--
-- WARNING: if any row has been populated with these columns (i.e.
-- Phase 1.6.2 has shipped and call_analyst has run), this drop loses
-- that data. Confirm the columns are unpopulated before rolling back:
--   SELECT count(*) FROM context_memory
--    WHERE related_entity_id IS NOT NULL OR related_entity_type IS NOT NULL;

DROP INDEX IF EXISTS public.idx_context_memory_entity_pair;
DROP INDEX IF EXISTS public.idx_context_memory_related_entity;

ALTER TABLE public.context_memory
  DROP CONSTRAINT IF EXISTS context_memory_related_entity_type_check;

ALTER TABLE public.context_memory
  DROP COLUMN IF EXISTS related_entity_id;

ALTER TABLE public.context_memory
  DROP COLUMN IF EXISTS related_entity_type;
