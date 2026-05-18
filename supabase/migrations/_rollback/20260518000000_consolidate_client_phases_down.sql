-- Rollback: client phase consolidation
-- ===================================
-- Restores the pre-consolidation 5-active-phase model by reading the
-- preserved original_phase column on clients and rewinding the seeded
-- action_item_rules entries. Safe to re-run.
--
-- After this rollback, the corresponding code changes
-- (CLIENT_PHASES, DEFAULT_CLIENT_TASKS, OVERDUE_THRESHOLDS,
-- AI tools enum) must also be reverted for the UI to render the
-- restored phases. The rollback does NOT drop clients.original_phase
-- so a future re-run of the forward migration is still safe.

BEGIN;

-- ── 1) Restore client.phase from clients.original_phase ───────────
UPDATE public.clients
SET phase = original_phase
WHERE original_phase IS NOT NULL
  AND original_phase IN ('initial_contact', 'consultation', 'assessment')
  AND phase IN ('consult', 'proposal');

-- ── 2) Revert seeded action_item_rules to pre-migration condition ──
UPDATE public.action_item_rules
SET condition_config = jsonb_set(condition_config, '{phase}', '"initial_contact"'::jsonb)
WHERE id = 'cl_no_contact'
  AND condition_config->>'phase' = 'consult';

UPDATE public.action_item_rules
SET condition_config = jsonb_set(condition_config, '{phase}', '"assessment"'::jsonb),
    name = 'Assessment Overdue',
    title_template = 'Assessment overdue — Day {{days_in_phase}}',
    detail_template = 'Assessment phase open {{days_in_phase}} days — home visit may be delayed or needs rescheduling.'
WHERE id = 'cl_assessment_overdue'
  AND condition_config->>'phase' = 'proposal';

-- Note: we intentionally do NOT clear phase_timestamps keys we added
-- on the forward path. The extra 'consult' / 'proposal' keys are
-- harmless audit data after rollback (the active code reads
-- 'initial_contact' / 'consultation' / 'assessment').

COMMIT;
