-- Client pipeline phase consolidation
-- ====================================
-- Reduces the active phase set from five (new_lead → initial_contact →
-- consultation → assessment → proposal) to three (new_lead → consult →
-- proposal). The terminal phases (won, lost, nurture) are unchanged.
--
-- Mapping:
--   initial_contact + consultation → consult
--   assessment                     → proposal
--
-- Production safety:
--   * Reversible. The pre-migration phase value is preserved in
--     clients.original_phase so the rollback migration can restore it.
--   * Additive on phase_timestamps. We add a 'consult' key (set to the
--     earliest of any existing initial_contact / consultation values)
--     and, where 'proposal' is missing, copy 'assessment' into it. The
--     old keys ('initial_contact', 'consultation', 'assessment') are
--     preserved as audit history.
--   * Idempotent. Re-running this migration is safe: ADD COLUMN IF NOT
--     EXISTS, original_phase is only set when null, and the UPDATEs
--     match on the now-extinct old phase values so a second run finds
--     no rows.
--   * Action item rule remap is keyed by stable rule id and matches the
--     specific old phase string, so user-edited rules are untouched.

BEGIN;

-- ── 1) Preserve the pre-consolidation phase value ──────────────────
-- Nullable text column, populated only for clients sitting on one of
-- the phases this migration is about to remap. Already-migrated rows
-- keep their original_phase from the first run.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS original_phase text;

UPDATE public.clients
SET original_phase = phase
WHERE original_phase IS NULL
  AND phase IN ('initial_contact', 'consultation', 'assessment');

-- ── 2) Remap initial_contact + consultation → consult ─────────────
-- phase_timestamps gets a 'consult' key set to the earlier of the two
-- old timestamps (or whichever exists). Old keys stay intact.
UPDATE public.clients
SET phase = 'consult',
    phase_timestamps = COALESCE(phase_timestamps, '{}'::jsonb)
      || jsonb_build_object(
        'consult',
        to_jsonb(LEAST(
          NULLIF(COALESCE((phase_timestamps->>'initial_contact')::bigint, 0), 0),
          NULLIF(COALESCE((phase_timestamps->>'consultation')::bigint, 0), 0)
        ))
      )
WHERE phase IN ('initial_contact', 'consultation');

-- For clients with phase_timestamps but neither old key (edge case —
-- phase set without timestamp), set 'consult' to now so the Day-N
-- counter doesn't start from zero historic origin.
UPDATE public.clients
SET phase_timestamps = COALESCE(phase_timestamps, '{}'::jsonb)
  || jsonb_build_object('consult', to_jsonb((extract(epoch from now()) * 1000)::bigint))
WHERE phase = 'consult'
  AND (phase_timestamps->'consult') IS NULL;

-- ── 3) Remap assessment → proposal ────────────────────────────────
-- If 'proposal' is already populated (rare: client cycled back), keep
-- the existing value. Otherwise, copy the assessment timestamp.
UPDATE public.clients
SET phase = 'proposal',
    phase_timestamps = COALESCE(phase_timestamps, '{}'::jsonb)
      || jsonb_build_object(
        'proposal',
        COALESCE(
          phase_timestamps->'proposal',
          phase_timestamps->'assessment',
          to_jsonb((extract(epoch from now()) * 1000)::bigint)
        )
      )
WHERE phase = 'assessment';

-- ── 4) Remap seeded action_item_rules ─────────────────────────────
-- The 'cl_no_contact' and 'cl_assessment_overdue' rules reference the
-- old phases in condition_config. We only touch them when the
-- condition_config still matches the seed value — any rule a user has
-- edited away from the default is preserved as-is.
UPDATE public.action_item_rules
SET condition_config = jsonb_set(condition_config, '{phase}', '"consult"'::jsonb)
WHERE id = 'cl_no_contact'
  AND condition_config->>'phase' = 'initial_contact';

UPDATE public.action_item_rules
SET condition_config = jsonb_set(condition_config, '{phase}', '"proposal"'::jsonb),
    name = 'Proposal Overdue',
    template_title = 'Proposal overdue — Day {{days_in_phase}}',
    template_message = 'Proposal phase open {{days_in_phase}} days — follow up to keep momentum.'
WHERE id = 'cl_assessment_overdue'
  AND condition_config->>'phase' = 'assessment';

-- ── 5) Post-condition sanity (no migrated rows left orphaned) ─────
DO $$
DECLARE
  stragglers integer;
BEGIN
  SELECT COUNT(*) INTO stragglers
  FROM public.clients
  WHERE phase IN ('initial_contact', 'consultation', 'assessment');
  IF stragglers > 0 THEN
    RAISE EXCEPTION
      'Client phase consolidation incomplete: % rows still on legacy phases',
      stragglers;
  END IF;
END;
$$;

COMMIT;
