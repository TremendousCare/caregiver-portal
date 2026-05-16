-- Phase 1.6.2 — extend ai_suggestions.source_type CHECK to include
-- 'call_analyst'.
--
-- The Phase 1.6.2 `call_analyst` agent writes per-action-item rows to
-- ai_suggestions with `source_type='call_analyst'` so downstream
-- consumers (notification center, /agent-grading, autonomy v2) can
-- filter by origin. The pre-1.6.2 enum is a five-value set
-- ('inbound_sms', 'inbound_email', 'proactive', 'outcome',
-- 'event_triggered') — the original four from migration
-- 20260311200407 plus 'event_triggered' added later by
-- 20260321220555_fix_source_type_constraint.sql when the proactive
-- planner started writing event-triggered suggestions. Adding
-- 'call_analyst' is purely additive on top of that.
--
-- Per Prime Directive #1 (production safety, additive only), this
-- migration only adds a value to the CHECK enum. No rows are touched.
-- The constraint is recreated rather than ALTERed because Postgres
-- doesn't support adding values to a CHECK constraint in-place; the
-- recreate runs inside a transaction and is fast on this small table.
--
-- Future analysts (intake_analyst, scheduling_analyst) will each add
-- their own source_type value via a similar additive migration. Per
-- Prime Directive #7 (coarse first, split when data signals it), we
-- don't pre-add slots for those agents now.
--
-- Idempotent: drops the constraint by name (no-op if absent) and
-- recreates it. Re-running adds no new value because IN-list
-- comparisons are set-style. Safe to re-run via `supabase db push`.

DO $$
BEGIN
  -- Drop the existing CHECK if present. The name was assigned by
  -- Postgres at table-creation time; locate it dynamically rather
  -- than guessing.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ai_suggestions'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%source_type%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE public.ai_suggestions DROP CONSTRAINT ' || quote_ident(conname)
        FROM pg_constraint
       WHERE conrelid = 'public.ai_suggestions'::regclass
         AND contype  = 'c'
         AND pg_get_constraintdef(oid) ILIKE '%source_type%'
       LIMIT 1
    );
  END IF;
END
$$;

ALTER TABLE public.ai_suggestions
  ADD CONSTRAINT ai_suggestions_source_type_check
  CHECK (source_type IN (
    'inbound_sms',
    'inbound_email',
    'proactive',
    'outcome',
    'event_triggered',
    'call_analyst'
  ));

-- Sanity check: confirm the new value is in the enum.
DO $$
DECLARE
  v_defn text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_defn
    FROM pg_constraint
   WHERE conrelid = 'public.ai_suggestions'::regclass
     AND conname  = 'ai_suggestions_source_type_check';

  IF v_defn IS NULL OR v_defn NOT ILIKE '%call_analyst%' THEN
    RAISE EXCEPTION
      'ai_suggestions source_type extension failed: call_analyst not present in CHECK after migration';
  END IF;
  -- Also confirm we didn't accidentally drop 'event_triggered' (a
  -- regression that caused the original 1.6.2 deploy to fail because
  -- production rows already used it).
  IF v_defn NOT ILIKE '%event_triggered%' THEN
    RAISE EXCEPTION
      'ai_suggestions source_type extension regression: event_triggered missing from CHECK after migration';
  END IF;
END
$$;

COMMENT ON CONSTRAINT ai_suggestions_source_type_check
  ON public.ai_suggestions IS
  'Phase 1.6.2: enum extended to include call_analyst (call-derived '
  'suggestions). Previous five values preserved exactly: inbound_sms, '
  'inbound_email, proactive, outcome, event_triggered.';
