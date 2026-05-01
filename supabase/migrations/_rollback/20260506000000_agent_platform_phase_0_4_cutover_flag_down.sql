-- Rollback for Phase 0.4 cutover-flag seed.
-- Removes the seeded app_settings row. Edge functions interpret a missing
-- key as "all flags false" → legacy path. Safe to run alongside an
-- emergency edge-function rollback (revert the *.ts dispatch + this).
DELETE FROM public.app_settings WHERE key = 'agent_runtime_cutover';
