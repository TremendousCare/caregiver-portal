-- ═══════════════════════════════════════════════════════════════
-- Care Plan (clinical) — Phase 2a schema
--
-- Three new tables power the clinical care plan feature. This is a
-- separate concept from the scheduling `service_plans` table (which
-- is the hours/week contract). The clinical care plan is the rich
-- knowledge document about a client: demographics, medical profile,
-- ADL/IADL tasks, routines, safety, goals — everything the care
-- coordinator learns during intake and updates over time.
--
-- Tables:
--   1. care_plans           one row per client (canonical pointer)
--   2. care_plan_versions   immutable-once-published snapshots
--   3. care_plan_tasks      per-version task breakdown (Wellsky-style)
--
-- Versioning policy:
--   - A care plan always has a "current version" — either a draft or
--     the most recently published snapshot.
--   - Drafts are mutable; publishing snapshots the data and freezes
--     that version. New edits start a new draft version.
--   - Publishing records agency signature (typed name + timestamp)
--     and optional client signature for the Plan of Care copy.
--
-- Access (Phase 2a):
--   - Admin staff only. Caregivers will get scoped SELECT policies
--     in Phase 2d when the care plan is surfaced in the PWA.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. care_plans ───────────────────────────────────────────────
-- One row per client. Holds the pointer to the current version so
-- callers can resolve "the care plan for client X" in one query.

CREATE TABLE IF NOT EXISTS care_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'archived')),
  -- Pointer to the version currently shown in the UI. Typically the
  -- latest published version, or the working draft if no published
  -- version exists yet. NULL only between create and first version
  -- row insertion (should not persist).
  current_version_id  uuid,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One care plan per client. Archiving an old one means you can create
-- a new one, but in practice a client has exactly one active plan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_care_plans_one_active_per_client
  ON care_plans (client_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_care_plans_client
  ON care_plans (client_id);


-- ── 2. care_plan_versions ──────────────────────────────────────
-- Each edit cycle produces a new version row. Drafts are mutable;
-- once published, the row is frozen (enforced at the app layer, not
-- the DB, so admin corrections are still possible via migration).

CREATE TABLE IF NOT EXISTS care_plan_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_plan_id        uuid NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  version_number      int NOT NULL,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'archived')),
  -- Why this version was created: 'initial intake', 'post-hospitalization',
  -- 'quarterly review', 'condition change', 'family request', etc.
  -- Freeform text; the UI offers common options but accepts anything.
  version_reason      text,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Publish metadata (NULL while draft)
  published_at        timestamptz,
  published_by        text,
  -- Typed-name signatures captured at publish time. Plain text is
  -- acceptable for current scale; upgrade to DocuSign later if a
  -- payor audit requires it.
  client_signed_name  text,
  client_signed_at    timestamptz,
  agency_signed_name  text,
  agency_signed_at    timestamptz,
  -- Section content as JSONB. Shape: { [sectionId]: { ...sectionData } }.
  -- Sections are defined in src/features/care-plans/sections.js — the
  -- migration intentionally stays schema-flexible so new sections/fields
  -- can be added without migrations.
  data                jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- AI-generated "who is this client" paragraph, refreshed when the
  -- plan is published. Phase 2e feature, NULL until then.
  generated_summary   text,
  UNIQUE (care_plan_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_care_plan_versions_plan
  ON care_plan_versions (care_plan_id);

-- Published-timeline index: "the most recent published version for
-- plan X" is the single hottest query for the read-only view.
CREATE INDEX IF NOT EXISTS idx_care_plan_versions_published
  ON care_plan_versions (care_plan_id, published_at DESC)
  WHERE status = 'published';


-- ── Circular FK: care_plans.current_version_id → care_plan_versions.id ──
-- Now that versions table exists, finalize the pointer constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'care_plans_current_version_fkey'
      AND conrelid = 'public.care_plans'::regclass
  ) THEN
    ALTER TABLE care_plans
      ADD CONSTRAINT care_plans_current_version_fkey
      FOREIGN KEY (current_version_id) REFERENCES care_plan_versions(id)
      ON DELETE SET NULL;
  END IF;
END$$;


-- ── 3. care_plan_tasks ──────────────────────────────────────────
-- Normalized Wellsky-style ADL/IADL task list. One row per task per
-- version. Tasks are cloned forward when a new version is created.
-- Separate table (rather than JSONB inside versions.data) because:
--   - The caregiver app will query tasks per-shift
--   - AI pattern detection will aggregate tasks across clients
--   - Reports will filter by category / priority

CREATE TABLE IF NOT EXISTS care_plan_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id          uuid NOT NULL REFERENCES care_plan_versions(id) ON DELETE CASCADE,
  -- Dotted category: 'adl.bathing', 'iadl.housework', 'iadl.medication',
  -- 'iadl.observation'. Matches the breakdown in sections.js.
  category            text NOT NULL,
  task_name           text NOT NULL,
  description         text,
  -- Which shift(s) the task applies to. 'all' = every shift.
  -- Matches Wellsky's per-task shift metadata.
  shifts              text[] NOT NULL DEFAULT ARRAY['all']::text[],
  -- 0=Sun..6=Sat. Empty array = every day.
  days_of_week        int[] NOT NULL DEFAULT ARRAY[]::int[],
  priority            text NOT NULL DEFAULT 'standard'
                        CHECK (priority IN ('critical', 'standard', 'optional')),
  safety_notes        text,
  sort_order          int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_care_plan_tasks_version
  ON care_plan_tasks (version_id);

-- Category lookups for the per-shift caregiver task list come
-- in Phase 2d. Pre-create the supporting index so that code path
-- doesn't require a migration later.
CREATE INDEX IF NOT EXISTS idx_care_plan_tasks_version_category
  ON care_plan_tasks (version_id, category);


-- ── Row-Level Security ─────────────────────────────────────────
ALTER TABLE care_plans          ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_plan_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_plan_tasks     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS care_plans_staff_all          ON care_plans;
DROP POLICY IF EXISTS care_plan_versions_staff_all  ON care_plan_versions;
DROP POLICY IF EXISTS care_plan_tasks_staff_all     ON care_plan_tasks;

CREATE POLICY care_plans_staff_all ON care_plans
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

CREATE POLICY care_plan_versions_staff_all ON care_plan_versions
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

CREATE POLICY care_plan_tasks_staff_all ON care_plan_tasks
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());


-- ── Auto-update updated_at triggers ────────────────────────────
-- Shared helper so any future table can reuse it.
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS care_plans_touch_updated_at         ON care_plans;
DROP TRIGGER IF EXISTS care_plan_versions_touch_updated_at ON care_plan_versions;
DROP TRIGGER IF EXISTS care_plan_tasks_touch_updated_at    ON care_plan_tasks;

CREATE TRIGGER care_plans_touch_updated_at
  BEFORE UPDATE ON care_plans
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER care_plan_versions_touch_updated_at
  BEFORE UPDATE ON care_plan_versions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER care_plan_tasks_touch_updated_at
  BEFORE UPDATE ON care_plan_tasks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
