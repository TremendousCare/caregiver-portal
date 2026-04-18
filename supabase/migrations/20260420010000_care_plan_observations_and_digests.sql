-- ═══════════════════════════════════════════════════════════════
-- Care Plan (clinical) — Phase 2b scaffolding tables
--
-- Two new tables that will be populated by later phases, added now
-- to avoid a second migration once the UI catches up:
--
--   1. care_plan_observations
--      Caregiver-logged observations during a shift. One row per
--      observation — task completions, mood notes, concerns, positive
--      moments, vitals, general observations. Populated by the
--      caregiver PWA in Phase 2d.
--
--   2. care_plan_digests
--      AI-generated family-facing summaries (daily / weekly / monthly).
--      Blends the care plan's "who they are" context with recent
--      observations to produce warm, natural-language updates for the
--      Family Communication Hub. Populated by a scheduled job in
--      Phase 3.
--
-- Access (Phase 2b):
--   - Admin staff only. Caregiver insert policies for observations and
--     family read policies for digests ship in their respective phases.
--
-- Reminder: both tables are additive. No existing data is touched.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. care_plan_observations ──────────────────────────────────

CREATE TABLE IF NOT EXISTS care_plan_observations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_plan_id        uuid NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  -- The version of the plan that was active when the observation was
  -- logged. Preserved even if a new version is published afterwards so
  -- we know what the caregiver was looking at when they made the note.
  version_id          uuid NOT NULL REFERENCES care_plan_versions(id) ON DELETE RESTRICT,
  -- Optional link to a specific task (e.g. "bathing went well"). NULL
  -- for freeform observations that aren't tied to a task.
  task_id             uuid REFERENCES care_plan_tasks(id) ON DELETE SET NULL,
  -- Shift context. Observations logged outside a shift (rare — e.g.
  -- office check-in call) leave this NULL.
  shift_id            uuid REFERENCES shifts(id) ON DELETE SET NULL,
  -- Caregivers.id is text (matches existing schema). SET NULL on delete
  -- keeps historical observations intact if a caregiver is removed.
  caregiver_id        text REFERENCES caregivers(id) ON DELETE SET NULL,
  -- Kind of observation. Drives UI (different logging forms per type)
  -- and AI prompt construction (different weighting in digests).
  observation_type    text NOT NULL
                        CHECK (observation_type IN (
                          'task_completion',
                          'mood',
                          'concern',
                          'positive',
                          'vital',
                          'general'
                        )),
  -- Type-specific scalar. For task_completion: 'done' / 'partial' /
  -- 'not_done'. For mood: 'great' / 'good' / 'okay' / 'low' / 'poor'.
  -- For vitals: numeric-as-text (e.g. '128/82'). NULL when free-text
  -- in `note` is sufficient.
  rating              text,
  note                text,
  logged_at           timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Hot path: "show this plan's recent observations" for the admin view
-- and for AI digest generation.
CREATE INDEX IF NOT EXISTS idx_care_plan_observations_plan
  ON care_plan_observations (care_plan_id, logged_at DESC);

-- "What did this caregiver log this week" for caregiver dashboards.
CREATE INDEX IF NOT EXISTS idx_care_plan_observations_caregiver
  ON care_plan_observations (caregiver_id, logged_at DESC);

-- "Observations during this shift" — cheap lookup for shift review.
CREATE INDEX IF NOT EXISTS idx_care_plan_observations_shift
  ON care_plan_observations (shift_id)
  WHERE shift_id IS NOT NULL;


-- ── 2. care_plan_digests ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS care_plan_digests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_plan_id          uuid NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  -- Denormalized for the Family Communication Hub which queries by
  -- client_id directly without joining through care_plans.
  client_id             text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period_type           text NOT NULL
                          CHECK (period_type IN ('daily', 'weekly', 'monthly', 'adhoc')),
  period_start          timestamptz NOT NULL,
  period_end            timestamptz NOT NULL,
  -- The main human-readable summary. Warm tone, family-appropriate.
  narrative             text NOT NULL,
  -- Structured positives ("went for a walk Tuesday", "ate well every
  -- meal"). Array of { text, icon?, observation_ids? }. Used by the
  -- family hub UI to render highlight chips.
  highlights            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Structured concerns ("fell Sunday evening", "reduced appetite Wed
  -- and Thu"). Array of { text, severity, observation_ids? } where
  -- severity is 'info' | 'watch' | 'urgent'. Drives family alerts.
  concerns              jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Which Claude model (or stub) generated this. Tracked for post-hoc
  -- quality evaluation as we iterate on prompts.
  model                 text,
  generated_at          timestamptz NOT NULL DEFAULT now(),
  -- When the digest was surfaced in the family hub. NULL = generated
  -- but not yet delivered (e.g. held for review).
  delivered_to_family_at timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Family hub queries: "latest digests for this client".
CREATE INDEX IF NOT EXISTS idx_care_plan_digests_client
  ON care_plan_digests (client_id, period_end DESC);

-- Admin review: "all digests for this plan".
CREATE INDEX IF NOT EXISTS idx_care_plan_digests_plan
  ON care_plan_digests (care_plan_id, period_end DESC);


-- ── Row-Level Security ─────────────────────────────────────────
-- Admin-only for now. Caregiver insert policies (observations) and
-- family-scoped read policies (digests) land in their respective
-- phases alongside the UI that needs them.

ALTER TABLE care_plan_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_plan_digests      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS care_plan_observations_staff_all ON care_plan_observations;
DROP POLICY IF EXISTS care_plan_digests_staff_all      ON care_plan_digests;

CREATE POLICY care_plan_observations_staff_all ON care_plan_observations
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());

CREATE POLICY care_plan_digests_staff_all ON care_plan_digests
  FOR ALL TO authenticated
  USING (public.is_staff()) WITH CHECK (public.is_staff());


-- ── Auto-update updated_at triggers ────────────────────────────
-- Reuses the touch_updated_at() function created in the Phase 2a
-- migration (20260419010000_care_plan_schema.sql).

DROP TRIGGER IF EXISTS care_plan_observations_touch_updated_at ON care_plan_observations;
DROP TRIGGER IF EXISTS care_plan_digests_touch_updated_at      ON care_plan_digests;

CREATE TRIGGER care_plan_observations_touch_updated_at
  BEFORE UPDATE ON care_plan_observations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER care_plan_digests_touch_updated_at
  BEFORE UPDATE ON care_plan_digests
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
