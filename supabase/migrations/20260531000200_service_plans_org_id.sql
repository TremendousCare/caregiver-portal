-- Phase B1 follow-up — add the org_id column that service_plans missed.
--
-- The Phase B1 sweep (20260426120000_phase_b_add_org_id_columns.sql) added
-- org_id to 42 tenant-sensitive tables. The scheduling service_plans table
-- was omitted: it had been renamed from care_plans -> service_plans only six
-- days earlier (20260419000000_rename_care_plans_to_service_plans.sql), and
-- the Phase B1 table list still referenced the *clinical* care_plans table
-- (created in 20260419010000_care_plan_schema.sql). So the scheduling
-- contract table silently shipped without org_id while every sibling
-- scheduling table (shifts, shift_offers, caregiver_availability, …) got it.
--
-- Production consequence: the "Regular caregivers" grid on the service plan
-- card (src/features/scheduling/RegularCaregiversGrid.jsx) guards its save
-- path on `plan.orgId`, which is mapped straight from this column
-- (dbToServicePlan: `orgId: row.org_id || null`). With the column absent it
-- was always null, so picking a caregiver no-oped with a "plan organization
-- is missing" toast for EVERY client. service_plan_caregiver_rules.org_id is
-- NOT NULL, so the per-day recurring-caregiver feature was unreachable from
-- that surface. (The shift-drawer "apply to future" path still worked because
-- it sources org_id from the shift row, which has the column.)
--
-- This migration applies the exact Phase B1 recipe to the one missed table:
--   nullable add -> backfill to Tremendous Care -> NOT NULL -> default -> index.
-- It is purely additive, changes no behavior in existing code paths, and
-- modifies no RLS policy. Once it lands, getServicePlansForClient (select '*')
-- returns org_id, the grid's plan.orgId is populated, and the feature works
-- with no frontend change. New inserts that omit org_id are covered by the
-- DEFAULT, identical to every other Phase B1 table.
--
-- Default-value strategy matches the locked decision (public.default_org_id(),
-- not a hardcoded UUID literal; see docs/SAAS_RETROFIT.md "Decisions locked,
-- 2026-04-26"). The helper already exists from the Phase B1 migration.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, an UPDATE that only touches NULL rows,
-- and SET NOT NULL / SET DEFAULT (both no-ops when already in place). Safe to
-- re-run via the Deploy Database Migrations workflow (--include-all).

DO $$
DECLARE
  v_tc_id uuid;
BEGIN
  -- Defensive: Phase A's seed must be in place. Abort loudly rather than
  -- backfilling NULL, which the NOT NULL step below would reject anyway.
  SELECT id INTO v_tc_id
  FROM public.organizations
  WHERE slug = 'tremendous-care';

  IF v_tc_id IS NULL THEN
    RAISE EXCEPTION
      'service_plans org_id backfill aborted: organizations row with slug=tremendous-care is missing. Phase A must be deployed first.';
  END IF;

  -- 1. Add column (nullable for now). Idempotent.
  ALTER TABLE public.service_plans
    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

  -- 2. Backfill any NULL rows to Tremendous Care's id. Idempotent — a re-run
  --    only touches rows that somehow ended up NULL.
  UPDATE public.service_plans SET org_id = v_tc_id WHERE org_id IS NULL;

  -- 3. Tighten: NOT NULL plus a default for any future insert that omits
  --    org_id. Default resolves identity at insert time, surviving any future
  --    Tremendous Care id reissue. Both statements are no-ops on re-run.
  ALTER TABLE public.service_plans ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE public.service_plans ALTER COLUMN org_id SET DEFAULT public.default_org_id();
END $$;

-- 4. Index on org_id. Required for the RLS predicates that ship in Phase B2
--    to be fast. Mirrors idx_<table>_org_id from the Phase B1 sweep.
CREATE INDEX IF NOT EXISTS idx_service_plans_org_id
  ON public.service_plans (org_id);

-- Sanity check. RAISE EXCEPTION aborts the migration transaction, so partial
-- state is impossible.
DO $$
DECLARE
  v_missing uuid;
BEGIN
  SELECT id INTO v_missing
  FROM public.service_plans
  WHERE org_id IS NULL
  LIMIT 1;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'service_plans org_id sanity check failed: rows with NULL org_id remain after backfill.';
  END IF;
END $$;
