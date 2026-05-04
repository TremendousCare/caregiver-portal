-- Customizable shift generation: ongoing (perpetual) service plans.
--
-- Until now, "Generate shifts" on a service plan was always a one-shot
-- finite expansion (default 4 weeks ahead). We're extending this so a
-- scheduler can mark a plan as "ongoing" — meaning a cron job
-- (`service-plan-extend-ongoing`) materializes a rolling window of
-- shifts week-over-week, in perpetuity, until the plan's `is_ongoing`
-- flag is turned off or the plan's `status` moves out of 'active'.
--
-- Two new columns:
--   is_ongoing            : the user-facing toggle. Default false; old
--                           plans behave exactly as before.
--   last_generated_through: bookkeeping for the cron — the latest shift
--                           end_time we've materialized for this plan.
--                           The cron tops up only when this drops
--                           below `now() + buffer`, making the job
--                           idempotent and cheap.
--
-- Multi-tenancy: `service_plans` already has `org_id` (Phase B1). Any
-- query the new cron issues filters by `id` on plan rows whose `org_id`
-- is an inherited fact, so no new tenant-isolation work is required.
--
-- Idempotent: every column add is `IF NOT EXISTS`. Safe to re-run via
-- the Deploy Database Migrations workflow.

ALTER TABLE public.service_plans
  ADD COLUMN IF NOT EXISTS is_ongoing boolean NOT NULL DEFAULT false;

ALTER TABLE public.service_plans
  ADD COLUMN IF NOT EXISTS last_generated_through timestamptz NULL;

COMMENT ON COLUMN public.service_plans.is_ongoing IS
  'When true, the service-plan-extend-ongoing cron keeps materializing shifts on a rolling window. Mutually exclusive with the finite duration the user picks in the Generate Shifts dialog.';

COMMENT ON COLUMN public.service_plans.last_generated_through IS
  'Latest shift.end_time that has been materialized for this plan. The extension cron reads this to decide whether to top up; updated by the dialog and the cron after each successful generation.';

-- Partial index supports the cron's hot query: find every active plan
-- whose runway is shrinking. Filtered to keep the index tiny.
CREATE INDEX IF NOT EXISTS idx_service_plans_ongoing_active
  ON public.service_plans (last_generated_through)
  WHERE is_ongoing = true AND status = 'active';
