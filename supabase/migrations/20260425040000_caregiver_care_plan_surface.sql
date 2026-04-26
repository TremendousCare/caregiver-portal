-- ═══════════════════════════════════════════════════════════════
-- Caregiver Care-Plan Surface — Phase 3
--
-- Opens up the care_plan family of tables to caregiver-side reads
-- (scoped to the clients of their assigned shifts) and lets caregivers
-- INSERT their own observations. Today these tables are staff-only;
-- the existing 20260418210000 migration explicitly deferred the
-- caregiver scoping to "a later phase when the PWA needs it" — that
-- phase is now.
--
-- Three pieces:
--
--   1. Extend the observation_type CHECK on care_plan_observations to
--      add 'shift_note' (free-form per-shift narrative) and 'refusal'
--      (client refused a task — typically tied to a task_id with the
--      reason in `note`). Done at the data-model level so admin
--      reports can query refusals as a structured category instead of
--      grepping free-text notes.
--
--   2. Caregiver-scoped SELECT policies on care_plans, care_plan_versions,
--      and care_plan_tasks. A caregiver can read the plan, version, and
--      tasks of any client they have an assigned shift OR an active
--      caregiver_assignment with — same scoping pattern the existing
--      clients_read_assigned policy uses (20260418210000:245-259).
--
--   3. Caregiver-scoped INSERT + SELECT policies on
--      care_plan_observations. Caregivers can read their own observations
--      and insert new ones, but only with caregiver_id matching their
--      own caregiver row and shift_id matching one of their shifts.
--
-- Plus a supporting composite index for the "what have I logged on
-- this shift" query the PWA runs on every shift detail load.
--
-- Additive + idempotent. No existing data touched. Staff-all policies
-- left intact.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Extend observation_type CHECK ───────────────────────────
-- Adds 'shift_note' (no task_id, free-form per-shift narrative) and
-- 'refusal' (typically tied to a task_id; note carries the reason).
-- Existing rows already pass the new constraint since their values
-- are a subset of the old enumeration.

ALTER TABLE care_plan_observations
  DROP CONSTRAINT IF EXISTS care_plan_observations_observation_type_check;

ALTER TABLE care_plan_observations
  ADD CONSTRAINT care_plan_observations_observation_type_check
  CHECK (observation_type IN (
    'task_completion',
    'mood',
    'concern',
    'positive',
    'vital',
    'general',
    'shift_note',
    'refusal'
  ));


-- ── 2. Caregiver-scoped SELECT on care_plan tables ─────────────
-- Mirrors the clients_read_assigned shape: a caregiver can read a
-- plan if they have at least one shift OR active assignment with the
-- plan's client. Versions and tasks chain off the plan they belong to.

DROP POLICY IF EXISTS care_plans_read_assigned ON care_plans;
CREATE POLICY care_plans_read_assigned ON care_plans
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM shifts
       WHERE shifts.client_id = care_plans.client_id
         AND shifts.assigned_caregiver_id = public.current_user_caregiver_id()
    )
    OR EXISTS (
      SELECT 1 FROM caregiver_assignments ca
       WHERE ca.client_id = care_plans.client_id
         AND ca.caregiver_id = public.current_user_caregiver_id()
         AND ca.status = 'active'
    )
  );

DROP POLICY IF EXISTS care_plan_versions_read_assigned ON care_plan_versions;
CREATE POLICY care_plan_versions_read_assigned ON care_plan_versions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM care_plans cp
       WHERE cp.id = care_plan_versions.care_plan_id
         AND (
           EXISTS (
             SELECT 1 FROM shifts s
              WHERE s.client_id = cp.client_id
                AND s.assigned_caregiver_id = public.current_user_caregiver_id()
           )
           OR EXISTS (
             SELECT 1 FROM caregiver_assignments ca
              WHERE ca.client_id = cp.client_id
                AND ca.caregiver_id = public.current_user_caregiver_id()
                AND ca.status = 'active'
           )
         )
    )
  );

DROP POLICY IF EXISTS care_plan_tasks_read_assigned ON care_plan_tasks;
CREATE POLICY care_plan_tasks_read_assigned ON care_plan_tasks
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM care_plan_versions v
        JOIN care_plans cp ON cp.id = v.care_plan_id
       WHERE v.id = care_plan_tasks.version_id
         AND (
           EXISTS (
             SELECT 1 FROM shifts s
              WHERE s.client_id = cp.client_id
                AND s.assigned_caregiver_id = public.current_user_caregiver_id()
           )
           OR EXISTS (
             SELECT 1 FROM caregiver_assignments ca
              WHERE ca.client_id = cp.client_id
                AND ca.caregiver_id = public.current_user_caregiver_id()
                AND ca.status = 'active'
           )
         )
    )
  );


-- ── 3. Caregiver-scoped SELECT + INSERT on care_plan_observations ──
-- A caregiver can read observations they themselves authored, and can
-- insert new ones — but only with caregiver_id = their own caregiver
-- row AND shift_id pointing at one of their shifts. UPDATE / DELETE
-- remain staff-only via the existing care_plan_observations_staff_all
-- policy (so caregiver-logged history is append-only from their side).

DROP POLICY IF EXISTS care_plan_observations_caregiver_read ON care_plan_observations;
CREATE POLICY care_plan_observations_caregiver_read ON care_plan_observations
  FOR SELECT TO authenticated
  USING (caregiver_id = public.current_user_caregiver_id());

DROP POLICY IF EXISTS care_plan_observations_caregiver_insert ON care_plan_observations;
CREATE POLICY care_plan_observations_caregiver_insert ON care_plan_observations
  FOR INSERT TO authenticated
  WITH CHECK (
    caregiver_id = public.current_user_caregiver_id()
    AND (
      shift_id IS NULL
      OR EXISTS (
        SELECT 1 FROM shifts s
         WHERE s.id = care_plan_observations.shift_id
           AND s.assigned_caregiver_id = public.current_user_caregiver_id()
      )
    )
  );


-- ── 4. Composite index for the per-shift caregiver lookup ──────
-- The PWA's shift detail screen runs:
--   SELECT * FROM care_plan_observations
--    WHERE shift_id = $1 AND caregiver_id = $2
--    ORDER BY logged_at DESC;
-- to render the current state of each task + the shift note. The
-- existing idx_care_plan_observations_shift covers shift_id alone but
-- the caregiver scope still has to be filtered. This index makes the
-- compound query a single index seek.

CREATE INDEX IF NOT EXISTS idx_care_plan_observations_shift_caregiver
  ON care_plan_observations (shift_id, caregiver_id, logged_at DESC)
  WHERE shift_id IS NOT NULL;
