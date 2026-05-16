-- Phase 1.6.2 hotfix — repair ai_suggestions.source_type CHECK
-- constraint to include all six values.
--
-- The previous migration (20260516023000) initially shipped with a
-- buggy five-value enum that dropped 'event_triggered'. Production
-- caught the regression at deploy time (the proactive planner had
-- been writing `source_type='event_triggered'` since migration
-- 20260321220555, so existing rows violated the new CHECK and the
-- transaction rolled back). 20260516023000 was edited in place to
-- include all six values — that's the fix for any environment where
-- the original deploy failed and the migration was never recorded
-- in `supabase_migrations.schema_migrations`.
--
-- This migration repairs the rare case where 20260516023000 was
-- applied successfully WITH the buggy 5-value enum (i.e. an env
-- that happened to have zero event_triggered rows at apply time).
-- It's also a no-op when 20260516023000 ran with the correct
-- 6-value enum, so it's safe to re-run unconditionally — that's
-- the whole point of an idempotent repair.
--
-- Idempotent:
--   1. Reads the current CHECK definition.
--   2. If it already contains all six expected values, no-op.
--   3. Otherwise drops + recreates with the full 6-value enum.
-- Safe under `supabase db push --include-all` re-runs.

DO $$
DECLARE
  v_defn text;
  v_needs_repair boolean := false;
  v_constraint_name text;
BEGIN
  SELECT conname, pg_get_constraintdef(oid) INTO v_constraint_name, v_defn
    FROM pg_constraint
   WHERE conrelid = 'public.ai_suggestions'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%source_type%'
   LIMIT 1;

  IF v_defn IS NULL THEN
    -- No source_type CHECK exists at all — earlier migration must
    -- have failed mid-way. Treat as repair-needed.
    v_needs_repair := true;
  ELSE
    -- Repair-needed if ANY of the six expected values is missing
    -- from the current definition.
    IF v_defn NOT ILIKE '%inbound_sms%'
       OR v_defn NOT ILIKE '%inbound_email%'
       OR v_defn NOT ILIKE '%proactive%'
       OR v_defn NOT ILIKE '%outcome%'
       OR v_defn NOT ILIKE '%event_triggered%'
       OR v_defn NOT ILIKE '%call_analyst%'
    THEN
      v_needs_repair := true;
    END IF;
  END IF;

  IF v_needs_repair THEN
    -- Drop the existing one if any.
    IF v_constraint_name IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE public.ai_suggestions DROP CONSTRAINT %I',
        v_constraint_name
      );
    END IF;
    -- Recreate with the full six-value enum.
    EXECUTE $sql$
      ALTER TABLE public.ai_suggestions
        ADD CONSTRAINT ai_suggestions_source_type_check
        CHECK (source_type IN (
          'inbound_sms',
          'inbound_email',
          'proactive',
          'outcome',
          'event_triggered',
          'call_analyst'
        ))
    $sql$;
    RAISE NOTICE 'ai_suggestions source_type CHECK repaired to 6-value enum';
  ELSE
    RAISE NOTICE 'ai_suggestions source_type CHECK already has all 6 values; no-op';
  END IF;
END
$$;

-- Sanity post-check: belt-and-suspenders. Migration fails loudly if
-- any of the six values is still missing afterwards.
DO $$
DECLARE
  v_defn text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_defn
    FROM pg_constraint
   WHERE conrelid = 'public.ai_suggestions'::regclass
     AND conname  = 'ai_suggestions_source_type_check';

  IF v_defn IS NULL THEN
    RAISE EXCEPTION 'ai_suggestions_source_type_check missing after repair';
  END IF;
  FOR v_defn IN
    SELECT unnest(ARRAY[
      'inbound_sms', 'inbound_email', 'proactive', 'outcome',
      'event_triggered', 'call_analyst'
    ])
  LOOP
    IF (SELECT pg_get_constraintdef(oid)
          FROM pg_constraint
         WHERE conrelid = 'public.ai_suggestions'::regclass
           AND conname  = 'ai_suggestions_source_type_check')
       NOT ILIKE '%' || v_defn || '%'
    THEN
      RAISE EXCEPTION
        'ai_suggestions source_type repair regression: % missing after repair', v_defn;
    END IF;
  END LOOP;
END
$$;
