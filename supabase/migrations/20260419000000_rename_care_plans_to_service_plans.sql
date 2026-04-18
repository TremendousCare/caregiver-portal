-- ═══════════════════════════════════════════════════════════════
-- Rename care_plans → service_plans
--
-- Why: the existing `care_plans` table holds the scheduling contract
-- (hours/week, recurrence pattern, start/end dates) — what home-care
-- vendors typically call a "service authorization" or "service plan".
-- A clinical "Care Plan" (assessment, ADL tasks, medications, routines,
-- safety, goals, etc.) is a separate concept coming in a follow-up
-- migration. To avoid having two different tables both called "care
-- plan" forever, rename the scheduling table here *before* building
-- the new clinical one.
--
-- This migration performs pure identifier renames — no data changes,
-- no schema changes beyond names. Foreign keys, indexes, policies,
-- and auto-generated constraint names are all updated to match.
--
-- Safety notes:
--   • FK integrity is preserved: Postgres stores foreign-key targets
--     by relation OID, not by name, so renaming `care_plans` to
--     `service_plans` does NOT break the FKs on `shifts` or
--     `caregiver_assignments`.
--   • Each step is wrapped in `IF EXISTS` so re-applying the migration
--     on an already-migrated database is a no-op.
--   • DDL in Postgres is transactional — this whole file runs in one
--     implicit transaction. Either all renames succeed or none do.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Rename the table itself ──────────────────────────────────
ALTER TABLE IF EXISTS care_plans RENAME TO service_plans;


-- ── 2. Rename FK columns on child tables ────────────────────────
-- These columns point at service_plans(id); their current names
-- (care_plan_id) no longer match the referenced table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'shifts'
      AND column_name  = 'care_plan_id'
  ) THEN
    ALTER TABLE shifts RENAME COLUMN care_plan_id TO service_plan_id;
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'caregiver_assignments'
      AND column_name  = 'care_plan_id'
  ) THEN
    ALTER TABLE caregiver_assignments RENAME COLUMN care_plan_id TO service_plan_id;
  END IF;
END$$;


-- ── 3. Rename indexes ───────────────────────────────────────────
ALTER INDEX IF EXISTS idx_care_plans_client        RENAME TO idx_service_plans_client;
ALTER INDEX IF EXISTS idx_care_plans_status_active RENAME TO idx_service_plans_status_active;
ALTER INDEX IF EXISTS idx_shifts_care_plan         RENAME TO idx_shifts_service_plan;
ALTER INDEX IF EXISTS idx_assignments_care_plan    RENAME TO idx_assignments_service_plan;


-- ── 4. Rename the RLS policy ────────────────────────────────────
-- The table rename carried the policy along automatically; this just
-- keeps the policy name aligned with the table name.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'service_plans'
      AND policyname = 'care_plans_staff_all'
  ) THEN
    ALTER POLICY care_plans_staff_all ON service_plans
      RENAME TO service_plans_staff_all;
  END IF;
END$$;


-- ── 5. Rename FK constraint names ───────────────────────────────
-- Postgres auto-generates FK constraint names from the referencing
-- column (e.g. `shifts_care_plan_id_fkey`). Renaming the column does
-- NOT rename the constraint, so we do it explicitly here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'shifts_care_plan_id_fkey'
      AND conrelid = 'public.shifts'::regclass
  ) THEN
    ALTER TABLE shifts
      RENAME CONSTRAINT shifts_care_plan_id_fkey
      TO shifts_service_plan_id_fkey;
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'caregiver_assignments_care_plan_id_fkey'
      AND conrelid = 'public.caregiver_assignments'::regclass
  ) THEN
    ALTER TABLE caregiver_assignments
      RENAME CONSTRAINT caregiver_assignments_care_plan_id_fkey
      TO caregiver_assignments_service_plan_id_fkey;
  END IF;
END$$;
