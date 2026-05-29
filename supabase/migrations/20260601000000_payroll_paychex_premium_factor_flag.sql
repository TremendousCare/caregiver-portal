-- Payroll: tell the CSV exporter that Paychex applies the OT/DT premium
-- factor itself, so it must send the BASE rate (not a pre-multiplied one).
--
-- Why: the first live payroll import (Jun 3 2026 check date, pay period
-- 2026-05-18..24) overpaid overtime by 1.5x. TC's Paychex Overtime Earning
-- carries an OT Factor of 1.50 ("Calc. Rate = base x 1.5, x 1.50 fac"), so
-- when the exporter sent the already-premium rate (base x 1.5) Paychex
-- multiplied again, paying OT at base x 2.25. Three caregivers were
-- overpaid a combined $177 before the run was caught pre-submit.
--
-- Fix: `csvExport.js` now reads
-- `organizations.settings.payroll.paychex_applies_premium_factor`. When
-- true, OT/DT rows carry the base / regular-rate-of-pay and Paychex applies
-- its own 1.5x / 2x factor. When false/absent, the legacy pre-multiply
-- behavior is preserved (back-compat for any org configured differently).
--
-- This migration seeds the flag = true for Tremendous Care only.
--
-- Idempotent: pure jsonb merge, safe to re-run.

UPDATE public.organizations
SET settings = settings
  || jsonb_build_object(
       'payroll',
       COALESCE(settings -> 'payroll', '{}'::jsonb)
         || jsonb_build_object(
              'paychex_applies_premium_factor', true
            )
     ),
    updated_at = now()
WHERE slug = 'tremendous-care';
