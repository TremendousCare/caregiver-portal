-- Rollback for 20260514000000_service_plan_caregiver_rules.sql
--
-- Safe to run: dropping this table has no effect on existing
-- service_plans or shifts rows. Code that reads the table guards
-- against it not existing.

DROP TRIGGER IF EXISTS trg_scpr_updated_at ON public.service_plan_caregiver_rules;
DROP FUNCTION IF EXISTS public.set_scpr_updated_at();
DROP TABLE IF EXISTS public.service_plan_caregiver_rules;
