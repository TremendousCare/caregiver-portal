-- Rollback for 20260601000000_payroll_paychex_premium_factor_flag.sql
--
-- Removes the `paychex_applies_premium_factor` flag from TC's payroll
-- settings, reverting the exporter to the legacy pre-multiply convention.
--
-- WARNING: reverting re-introduces the overtime double-multiplication bug
-- on the next CSV export. Only roll back alongside reverting the
-- `csvExport.js` code change.
--
-- Idempotent: #- on a missing key is a no-op.

UPDATE public.organizations
SET settings = settings #- '{payroll,paychex_applies_premium_factor}',
    updated_at = now()
WHERE slug = 'tremendous-care';
