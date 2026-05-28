-- Rollback for 20260531000200_service_plans_org_id.sql
--
-- Drops the org_id column (and its index) from service_plans. Safe because
-- the forward migration is purely additive and no RLS policy references the
-- column yet (Phase B2 isolation has not shipped for this table). The
-- frontend reads org_id defensively (`row.org_id || null`), so removing it
-- simply returns the Regular caregivers grid to its prior (non-saving)
-- behavior without erroring.
--
-- Note: the public.default_org_id() helper is intentionally NOT dropped — it
-- is shared by all 42 Phase B1 tables and owned by that migration.

DROP INDEX IF EXISTS public.idx_service_plans_org_id;
ALTER TABLE public.service_plans DROP COLUMN IF EXISTS org_id;
