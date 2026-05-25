-- Rollback for caregiver default pay rate v1.
--
-- ⚠️  Drops data: every caregiver's default_pay_rate and
--     default_pay_ot_rate is lost. Per CLAUDE.md Prime Directives,
--     destructive migrations need explicit owner approval. Run only
--     if you're certain no one's relying on these rates yet.

DROP TRIGGER IF EXISTS shifts_auto_fill_rates ON public.shifts;
DROP FUNCTION IF EXISTS public.auto_fill_shift_rates_from_defaults();

ALTER TABLE public.caregivers DROP COLUMN IF EXISTS default_pay_ot_rate;
ALTER TABLE public.caregivers DROP COLUMN IF EXISTS default_pay_rate;
