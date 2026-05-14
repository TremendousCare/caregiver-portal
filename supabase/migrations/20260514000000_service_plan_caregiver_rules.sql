-- ═══════════════════════════════════════════════════════════════
-- Scheduling: Regular caregiver rules per service plan
--
-- Adds a persistent layer between the recurrence pattern (which days
-- to materialize) and the materialized shift instance (who works
-- each one). A rule says "for service plan P, on day-of-week D,
-- caregiver C is the regular caregiver during the effective window."
--
-- The service-plan-extend-ongoing cron will look up active rules for
-- every new shift it materializes and pre-assign the caregiver,
-- closing the gap where the cron previously emitted only `status:
-- 'open'` rows that the office staff had to re-assign every 12 weeks.
--
-- Purely additive:
--   • No changes to existing tables.
--   • No data migration. Existing assignments stay on their shifts.
--   • The cron's behavior is bit-for-bit identical until the first
--     rule is written for a plan.
--
-- Multi-tenancy: every row carries `org_id`. Mirrors the Phase B1
-- pattern. The cron filters by plan id (which inherits org_id from
-- service_plans), and the frontend reads via the authenticated RLS
-- policy below. Phase B will tighten this policy in a future PR
-- across all scheduling tables in one pass.
--
-- See docs/SCHEDULING_CAREGIVER_RULES.md for the full design.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.service_plan_caregiver_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id),
  service_plan_id uuid NOT NULL REFERENCES public.service_plans(id) ON DELETE CASCADE,
  day_of_week     smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  -- 0 = Sunday … 6 = Saturday, matching Postgres extract(dow ...)
  -- and JS Date.getUTCDay(). Both the cron and the frontend share
  -- this convention via src/lib/scheduling/dayOfWeek.js.
  caregiver_id    text NOT NULL REFERENCES public.caregivers(id) ON DELETE CASCADE,
  effective_from  date NOT NULL,
  effective_to    date,
  -- NULL effective_to = open-ended ("Maria covers Thursdays until
  -- further notice"). When a successor rule is created, the
  -- predecessor's effective_to is set to the day before the
  -- successor's effective_from.
  notes           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scpr_dates_ordered CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  )
);

COMMENT ON TABLE public.service_plan_caregiver_rules IS
  'Persistent day-of-week caregiver assignments for a service plan. Read by the service-plan-extend-ongoing cron when materializing new shifts so future-materialized rows arrive pre-assigned rather than open. Created/expired by the service plan editor grid and the shift drawer''s "Apply to all future X-days" radio. See docs/SCHEDULING_CAREGIVER_RULES.md.';

COMMENT ON COLUMN public.service_plan_caregiver_rules.day_of_week IS
  '0 = Sunday … 6 = Saturday. Matches Postgres extract(dow from timestamp) and JS Date.getUTCDay().';

COMMENT ON COLUMN public.service_plan_caregiver_rules.effective_from IS
  'Inclusive start date. Defaults to today when the team creates a rule from the service plan grid; to the edited shift''s date when created via the shift drawer''s "Apply to future" radio.';

COMMENT ON COLUMN public.service_plan_caregiver_rules.effective_to IS
  'Inclusive end date. NULL = open-ended. Set when a successor rule is created or when the team removes the regular caregiver from this day.';


-- ── 2. Indexes ────────────────────────────────────────────────
-- Hot path: the cron's per-instance rule lookup. The composite
-- (service_plan_id, day_of_week, effective_from DESC) lets a single
-- index probe find the most-recent rule covering an instance date.
CREATE INDEX IF NOT EXISTS idx_scpr_lookup
  ON public.service_plan_caregiver_rules (service_plan_id, day_of_week, effective_from DESC);

-- Reverse lookup: "which plans does this caregiver currently cover?"
-- Used by the remove-from-client cascade and by conflict detection
-- when a new rule's caregiver is checked against existing rules.
CREATE INDEX IF NOT EXISTS idx_scpr_caregiver
  ON public.service_plan_caregiver_rules (caregiver_id, day_of_week);

-- Per-org filter for any future tenant-scoped queries.
CREATE INDEX IF NOT EXISTS idx_scpr_org
  ON public.service_plan_caregiver_rules (org_id);


-- ── 3. RLS ────────────────────────────────────────────────────
-- Matches the existing pattern on service_plans, shifts,
-- caregiver_availability, etc.: authenticated users have full
-- access. Phase B will replace these with per-org policies in a
-- single pass across the scheduling subsystem.
ALTER TABLE public.service_plan_caregiver_rules ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'service_plan_caregiver_rules_all'
      AND tablename  = 'service_plan_caregiver_rules'
  ) THEN
    CREATE POLICY service_plan_caregiver_rules_all
      ON public.service_plan_caregiver_rules
      FOR ALL TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;


-- ── 4. updated_at trigger ─────────────────────────────────────
-- Keeps updated_at fresh on every UPDATE. Mirrors the convention
-- used by other scheduling tables.
CREATE OR REPLACE FUNCTION public.set_scpr_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_scpr_updated_at'
      AND tgrelid = 'public.service_plan_caregiver_rules'::regclass
  ) THEN
    CREATE TRIGGER trg_scpr_updated_at
      BEFORE UPDATE ON public.service_plan_caregiver_rules
      FOR EACH ROW
      EXECUTE FUNCTION public.set_scpr_updated_at();
  END IF;
END$$;
