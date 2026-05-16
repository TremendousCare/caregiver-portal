-- Phase 1.6.1 — context_memory cross-entity reference columns.
--
-- The Phase 1.6.2 `call_analyst` agent extracts memories during call
-- analysis. Some of those memories are inherently cross-entity:
--   "caregiver Sarah and client Mrs. Johnson have a pairing tension —
--    avoid scheduling them together."
--
-- The existing `entity_type` / `entity_id` columns on `context_memory`
-- capture only ONE participant. Without a secondary reference the
-- relationship has to be encoded in `content` text and lost to
-- structured query. These columns are the structured cross-reference
-- so the recruiting / intake / scheduling agents can do queries like
-- "any memories involving this (caregiver × client) pair?" in Phase
-- 1.6.4's context-recipe extension.
--
-- Both columns are nullable — most memories continue to be single-
-- entity. No backfill is needed; the call_analyst stamps these on new
-- writes starting in Phase 1.6.2.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT
-- EXISTS`. Safe to re-run via `supabase db push`.

ALTER TABLE public.context_memory
  ADD COLUMN IF NOT EXISTS related_entity_type text;

ALTER TABLE public.context_memory
  ADD COLUMN IF NOT EXISTS related_entity_id text;

-- Same enum gate as the primary `entity_type` column. Allows 'system'
-- for org-level cross-entity context.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'context_memory_related_entity_type_check'
       AND conrelid = 'public.context_memory'::regclass
  ) THEN
    ALTER TABLE public.context_memory
      ADD CONSTRAINT context_memory_related_entity_type_check
      CHECK (related_entity_type IS NULL
             OR related_entity_type IN ('caregiver', 'client', 'system'));
  END IF;
END
$$;

-- Indexes for the "all memories referencing this entity (either side)"
-- and "memories about this specific pair" queries the Phase 1.6.4
-- context layer will issue. Partial on superseded_by IS NULL matches
-- the existing entity index pattern in this table.
CREATE INDEX IF NOT EXISTS idx_context_memory_related_entity
  ON public.context_memory (related_entity_type, related_entity_id)
  WHERE superseded_by IS NULL AND related_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_context_memory_entity_pair
  ON public.context_memory (entity_type, entity_id, related_entity_type, related_entity_id)
  WHERE superseded_by IS NULL AND related_entity_id IS NOT NULL;

COMMENT ON COLUMN public.context_memory.related_entity_type IS
  'Phase 1.6.1: structured cross-entity reference (paired with related_entity_id). '
  'Populated by call_analyst (Phase 1.6.2) on cross-entity memories.';

COMMENT ON COLUMN public.context_memory.related_entity_id IS
  'Phase 1.6.1: secondary entity referenced by this memory. NULL for '
  'single-entity memories (the existing default).';
