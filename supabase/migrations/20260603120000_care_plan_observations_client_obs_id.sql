-- ═══════════════════════════════════════════════════════════════
-- care_plan_observations.client_obs_id — offline idempotency key
--
-- The caregiver PWA can now log task ratings, notes, and refusals while
-- offline and sync them when connectivity returns. To make that sync
-- safely retryable (a flush that inserts a row but crashes before
-- clearing its outbox entry must not create a duplicate observation), the
-- PWA stamps each observation with a client-generated UUID. A unique
-- index on that id turns a re-sync into a no-op (the second insert hits
-- the unique violation and the outbox drops the entry as already-saved).
--
-- Additive and idempotent:
--   • column is nullable (old rows + any non-PWA writer leave it NULL)
--   • the unique index is PARTIAL (WHERE client_obs_id IS NOT NULL) so the
--     many existing NULL rows don't collide with each other
--   • ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS
-- Safe to re-run via the Deploy Database Migrations workflow.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE care_plan_observations
  ADD COLUMN IF NOT EXISTS client_obs_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_care_plan_observations_client_obs_id
  ON care_plan_observations (client_obs_id)
  WHERE client_obs_id IS NOT NULL;
