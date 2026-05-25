-- Caregiver default pay rates v1 — stops the office from manually
-- typing hourly_rate into every shift.
--
-- Office-coordinator feedback item #1 (Juliana, 2026-05-22):
--   "Rates" — pain point per follow-up discussion: caregivers and
--   clients should hold default pay/bill rates so new shifts
--   auto-fill. Missed rates today break payroll/invoicing
--   (client_missing_rate exception at end of week).
--
-- Design (locked with the owner 2026-05-26):
--
--   1. Two new nullable columns on caregivers:
--        default_pay_rate     numeric(10,2)
--        default_pay_ot_rate  numeric(10,2)
--      Mirrors the existing clients.default_billable_rate +
--      clients.default_billable_ot_rate that the invoicing migration
--      (20260502010000) already created. Same precision, same nullability.
--
--   2. Backfill: for caregivers where default_pay_rate IS NULL AND
--      proposed_pay_rate IS NOT NULL, copy proposed → default.
--      proposed_pay_rate is the "offer rate" captured during the
--      interview-eval template. For caregivers who already accepted,
--      this is the operating rate today. One-shot, idempotent.
--      NEVER overwrites an existing default_pay_rate.
--
--   3. Trigger auto_fill_shift_rates_from_defaults (BEFORE INSERT
--      OR UPDATE OF assigned_caregiver_id, client_id, hourly_rate,
--      billable_rate ON shifts):
--        - If NEW.hourly_rate IS NULL and a caregiver is assigned,
--          look up caregivers.default_pay_rate and set it.
--        - If NEW.billable_rate IS NULL and a client is assigned,
--          look up clients.default_billable_rate and set it.
--      Never overwrites an explicitly-set rate. SECURITY DEFINER
--      with pinned search_path. Defense-in-depth: also matches
--      org_id so a cross-tenant lookup is impossible.
--
--   4. NO override-with-reason audit trail in this PR (owner deferred
--      to v2). NO OT auto-fill logic — only regular. OT is computed
--      ex post by payroll, so a single shift's "OT rate" isn't
--      meaningful at scheduling time; the default_pay_ot_rate column
--      exists to feed payroll's rate-of-pay calculation later.
--
-- Multi-tenancy compliance (CLAUDE.md Prime Directives):
--   - Both columns sit on caregivers, which already has org_id (Phase B1).
--     No new tables, no new RLS work.
--   - Trigger filters by NEW.org_id so a Tremendous Care shift never
--     reads an Acme caregiver default.
--   - Pure additive — no DROPs, no DELETEs, columns nullable forever.
--   - Re-runnable via Deploy Database Migrations workflow.

-- ────────────────────────────────────────────────────────────────────
-- 1. New columns
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE public.caregivers
  ADD COLUMN IF NOT EXISTS default_pay_rate     numeric(10,2);
ALTER TABLE public.caregivers
  ADD COLUMN IF NOT EXISTS default_pay_ot_rate  numeric(10,2);

-- ────────────────────────────────────────────────────────────────────
-- 2. Backfill from proposed_pay_rate (one-shot, idempotent)
-- ────────────────────────────────────────────────────────────────────
-- Only fills nulls — re-running the migration won't clobber any rates
-- the office has manually set since the last run. proposed_pay_rate
-- has its own (6,2) precision; numeric coercion to (10,2) is safe.

UPDATE public.caregivers
   SET default_pay_rate = proposed_pay_rate
 WHERE default_pay_rate IS NULL
   AND proposed_pay_rate IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
-- 3. Trigger: auto-fill shift rates from caregiver/client defaults
-- ────────────────────────────────────────────────────────────────────
-- Why a trigger and not just frontend logic:
--   - Frontend prefill handles the common path (office creates shift
--     in ShiftForm). The trigger covers everything else: bulk imports,
--     edge functions, sequence automations, future API integrations.
--   - It's the only place that can guarantee shifts never land in
--     the DB with NULL rates when defaults exist.
--
-- Why BEFORE not AFTER:
--   - We're modifying NEW; BEFORE lets us return the row with the
--     filled-in rate so it's persisted in the same insert. AFTER
--     would require a second UPDATE statement and lose the
--     all-in-one transaction.
--
-- Why filter by org_id in the lookup:
--   - Defense-in-depth. Today `caregivers.id` and `clients.id` are
--     unique across the cluster (text PKs), so a cross-tenant lookup
--     is already impossible. But when Phase B fully tightens to
--     org-scoped IDs, the org_id guard becomes load-bearing. Adding
--     it now means no future schema migration has to touch this
--     trigger.

CREATE OR REPLACE FUNCTION public.auto_fill_shift_rates_from_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caregiver_rate numeric(10,2);
  v_client_rate    numeric(10,2);
BEGIN
  -- Auto-fill hourly_rate (caregiver pay) if missing.
  IF NEW.hourly_rate IS NULL AND NEW.assigned_caregiver_id IS NOT NULL THEN
    SELECT c.default_pay_rate
      INTO v_caregiver_rate
      FROM public.caregivers c
     WHERE c.id = NEW.assigned_caregiver_id
       AND (NEW.org_id IS NULL OR c.org_id = NEW.org_id);
    IF v_caregiver_rate IS NOT NULL THEN
      NEW.hourly_rate := v_caregiver_rate;
    END IF;
  END IF;

  -- Auto-fill billable_rate (client charge) if missing.
  IF NEW.billable_rate IS NULL AND NEW.client_id IS NOT NULL THEN
    SELECT cl.default_billable_rate
      INTO v_client_rate
      FROM public.clients cl
     WHERE cl.id = NEW.client_id
       AND (NEW.org_id IS NULL OR cl.org_id = NEW.org_id);
    IF v_client_rate IS NOT NULL THEN
      NEW.billable_rate := v_client_rate;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.auto_fill_shift_rates_from_defaults() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auto_fill_shift_rates_from_defaults()
  TO authenticated, service_role;

DROP TRIGGER IF EXISTS shifts_auto_fill_rates ON public.shifts;
CREATE TRIGGER shifts_auto_fill_rates
  BEFORE INSERT OR UPDATE OF assigned_caregiver_id, client_id, hourly_rate, billable_rate
  ON public.shifts
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_fill_shift_rates_from_defaults();

-- ────────────────────────────────────────────────────────────────────
-- 4. Sanity check
-- ────────────────────────────────────────────────────────────────────
-- Fail the deploy loudly if the columns or trigger didn't land. Cheap
-- way to catch a partial-apply situation (e.g., migration was edited
-- mid-deploy and the trigger half got rolled back).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'caregivers'
       AND column_name = 'default_pay_rate'
  ) THEN
    RAISE EXCEPTION 'caregiver default pay rate: caregivers.default_pay_rate missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'caregivers'
       AND column_name = 'default_pay_ot_rate'
  ) THEN
    RAISE EXCEPTION 'caregiver default pay rate: caregivers.default_pay_ot_rate missing after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'shifts_auto_fill_rates'
       AND tgrelid = 'public.shifts'::regclass
  ) THEN
    RAISE EXCEPTION 'caregiver default pay rate: shifts_auto_fill_rates trigger missing after migration';
  END IF;
END $$;
