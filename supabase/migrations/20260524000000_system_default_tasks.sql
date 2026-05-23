-- System default tasks — universal recurring tasks that appear on
-- every caregiver's shift checklist regardless of the client.
--
-- Office-coordinator feedback (Juliana, 2026-05-22, item #4):
--   "Add default recurring care plan tasks that can automatically
--    populate for all clients, such as: Caregiver break, Caregiver
--    lunch, Hand hygiene."
--
-- These are CAREGIVER actions (compliance / labor / infection-control),
-- not client-care actions. They don't belong inside any specific
-- care_plan_version because they apply to every shift across every
-- client. A dedicated table is the cleanest home.
--
-- Architecture (decided in PR #391's followup discussion):
--   • New table `system_default_tasks` — org-scoped, same shape as
--     care_plan_tasks minus the version_id FK.
--   • care_plan_observations gets a nullable sibling column
--     `system_default_task_id` so a caregiver's "done / partial /
--     not_done" rating on a system default can be stored without
--     pretending the row belongs to a care plan version.
--   • Runtime union: loadCarePlanForShift() loads system defaults
--     for the caller's org and merges them with the plan's tasks.
--   • CarePlanChecklist renders both kinds identically; the click
--     handler routes the observation to the correct ID column.
--
-- Multi-tenancy compliance (CLAUDE.md → Prime Directives):
--   • NOT NULL org_id DEFAULT public.default_org_id() REFERENCES
--     organizations(id) — Prime Directive #2.
--   • RLS gates on public.is_staff() for writes; SELECT is allowed
--     for any authenticated row in the same org (caregivers need to
--     SEE defaults in the PWA, mirroring the
--     care_plan_tasks_read_assigned policy pattern from
--     migration 20260425040000 but simpler — no need to gate on
--     which client a caregiver is assigned to, because system
--     defaults apply universally within the org).
--   • Seed runs per-org via a SELECT-from-organizations so a future
--     org gets the defaults automatically when its row is inserted
--     by Phase A's signup flow.
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS so the Deploy
-- Database Migrations workflow can re-run this safely.

-- ────────────────────────────────────────────────────────────────────
-- 1. system_default_tasks
-- ────────────────────────────────────────────────────────────────────
-- Same shape as care_plan_tasks (so the runtime union code is trivial)
-- minus version_id (universal) plus is_active (so an admin can disable
-- a default without deleting historical observations that reference
-- it) plus org_id (multi-tenant) plus UNIQUE (org_id, task_name) so
-- the seed and any future re-seed are idempotent.

CREATE TABLE IF NOT EXISTS public.system_default_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT public.default_org_id()
                    REFERENCES public.organizations(id) ON DELETE CASCADE,
  category        text NOT NULL,
  task_name       text NOT NULL,
  description     text,
  shifts          text[] NOT NULL DEFAULT ARRAY['all']::text[],
  days_of_week    int[] NOT NULL DEFAULT ARRAY[]::int[],
  priority        text NOT NULL DEFAULT 'standard'
                    CHECK (priority IN ('critical', 'standard', 'optional')),
  safety_notes    text,
  sort_order      int NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, task_name)
);

CREATE INDEX IF NOT EXISTS idx_system_default_tasks_org
  ON public.system_default_tasks (org_id);
CREATE INDEX IF NOT EXISTS idx_system_default_tasks_active
  ON public.system_default_tasks (org_id)
  WHERE is_active;

DROP TRIGGER IF EXISTS system_default_tasks_touch_updated_at
  ON public.system_default_tasks;
CREATE TRIGGER system_default_tasks_touch_updated_at
  BEFORE UPDATE ON public.system_default_tasks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────────
-- 2. care_plan_observations.system_default_task_id
-- ────────────────────────────────────────────────────────────────────
-- Sibling FK to system_default_tasks. Mutually exclusive with task_id
-- via a CHECK constraint — a single observation cannot reference both
-- a care_plan_task AND a system_default_task at once. Both NULL is
-- still valid (shift_note, mood, general — no specific task).

ALTER TABLE public.care_plan_observations
  ADD COLUMN IF NOT EXISTS system_default_task_id uuid
    REFERENCES public.system_default_tasks(id) ON DELETE SET NULL;

-- The CHECK lives in its own ALTER so adding it is idempotent (DROP
-- IF EXISTS guards the re-run, since CHECK has no IF NOT EXISTS form).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'care_plan_observations_task_source_xor'
      AND conrelid = 'public.care_plan_observations'::regclass
  ) THEN
    ALTER TABLE public.care_plan_observations
      ADD CONSTRAINT care_plan_observations_task_source_xor
      CHECK (task_id IS NULL OR system_default_task_id IS NULL);
  END IF;
END $$;

-- Hot path: "show this caregiver's system-default completions on this
-- shift" — keeps the indexer in indexLatestTaskCompletions() cheap.
CREATE INDEX IF NOT EXISTS idx_care_plan_observations_system_default_task
  ON public.care_plan_observations (system_default_task_id)
  WHERE system_default_task_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
-- 3. RLS — staff full CRUD + caregiver read, org-scoped
-- ────────────────────────────────────────────────────────────────────
-- Caregivers (PWA users) need SELECT so the checklist can render
-- system defaults. Unlike care_plan_tasks_read_assigned (which gates
-- on the caregiver being assigned to the specific client), system
-- defaults are universal within an org — every caregiver sees them.
-- The org_id fence still applies.

ALTER TABLE public.system_default_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_default_tasks_authenticated_select
  ON public.system_default_tasks;
CREATE POLICY system_default_tasks_authenticated_select
  ON public.system_default_tasks
  FOR SELECT
  TO authenticated
  USING (
    org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

DROP POLICY IF EXISTS system_default_tasks_staff_insert
  ON public.system_default_tasks;
CREATE POLICY system_default_tasks_staff_insert
  ON public.system_default_tasks
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

DROP POLICY IF EXISTS system_default_tasks_staff_update
  ON public.system_default_tasks;
CREATE POLICY system_default_tasks_staff_update
  ON public.system_default_tasks
  FOR UPDATE
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  )
  WITH CHECK (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

DROP POLICY IF EXISTS system_default_tasks_staff_delete
  ON public.system_default_tasks;
CREATE POLICY system_default_tasks_staff_delete
  ON public.system_default_tasks
  FOR DELETE
  TO authenticated
  USING (
    public.is_staff()
    AND org_id = nullif((auth.jwt() ->> 'org_id'), '')::uuid
  );

-- ────────────────────────────────────────────────────────────────────
-- 4. Seed: 3 default tasks per organization
-- ────────────────────────────────────────────────────────────────────
-- Category prefix 'caregiver.' is new and semantically distinct from
-- 'adl.*' / 'iadl.*' (client care). The PWA's category label map
-- gets matching entries in src/lib/shiftTaskFilter.js.
--
-- Sort orders chosen so hygiene (critical) sits at the top of any
-- groupTasksByCategory render, break + lunch fall later.
--
-- ON CONFLICT DO NOTHING via the UNIQUE (org_id, task_name) index
-- makes this safe to re-run on existing orgs.

INSERT INTO public.system_default_tasks
  (org_id, category, task_name, description, priority, sort_order, shifts)
SELECT
  o.id,
  'caregiver.hygiene',
  'Hand hygiene',
  'Wash or sanitize hands before and after each care task and before handling food.',
  'critical',
  1,
  ARRAY['all']::text[]
FROM public.organizations o
ON CONFLICT (org_id, task_name) DO NOTHING;

INSERT INTO public.system_default_tasks
  (org_id, category, task_name, description, priority, sort_order, shifts)
SELECT
  o.id,
  'caregiver.break',
  'Caregiver break',
  'Standard 10-minute paid rest break per labor compliance. Log when taken.',
  'standard',
  100,
  ARRAY['all']::text[]
FROM public.organizations o
ON CONFLICT (org_id, task_name) DO NOTHING;

INSERT INTO public.system_default_tasks
  (org_id, category, task_name, description, priority, sort_order, shifts)
SELECT
  o.id,
  'caregiver.lunch',
  'Caregiver lunch',
  'Unpaid 30-minute meal break per labor compliance for shifts of 6+ hours.',
  'standard',
  110,
  ARRAY['all']::text[]
FROM public.organizations o
ON CONFLICT (org_id, task_name) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────
-- 5. Sanity check
-- ────────────────────────────────────────────────────────────────────
-- Fail loudly if any of the three defaults missed the seed for the
-- Tremendous Care org. Catches a regression where someone renames a
-- task in a future PR without updating the seed.

DO $$
DECLARE
  v_count integer;
  v_tc_org_id uuid;
BEGIN
  v_tc_org_id := public.default_org_id();
  IF v_tc_org_id IS NULL THEN
    -- Phase A may not be live in a non-prod sandbox; skip the check
    -- rather than fail. Production has the helper set up.
    RAISE NOTICE 'system_default_tasks: default_org_id() returned NULL; skipping seed sanity check';
    RETURN;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.system_default_tasks
   WHERE org_id = v_tc_org_id
     AND task_name IN ('Hand hygiene', 'Caregiver break', 'Caregiver lunch');

  IF v_count <> 3 THEN
    RAISE EXCEPTION
      'system_default_tasks: expected 3 seeded defaults for default org, found %', v_count;
  END IF;
END $$;
