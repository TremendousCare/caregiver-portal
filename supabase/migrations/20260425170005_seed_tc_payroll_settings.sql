-- Paychex integration Phase 1: seed Tremendous Care payroll settings.
--
-- Writes TC-specific Paychex configuration into the existing
-- `organizations` row identified by slug = 'tremendous-care'. All
-- values come from owner-confirmed answers captured in the plan's
-- "Resolved 2026-04-25 in Phase 1 design conversation" section, plus
-- the `companyId` discovered by the Phase 0 paychex-diagnostic
-- function (PR #207, captured in PR #209).
--
-- This migration ONLY touches Tremendous Care's row. Any future org
-- gets its own seed when onboarded (manual seed in Phase B/D, or
-- self-serve in Phase E).
--
-- Idempotent: jsonb merge (||) overwrites whatever's already at these
-- keys with the canonical values. Re-running the migration is safe.
-- Does NOT touch any other keys that may already exist in
-- organizations.settings (e.g., Phase A retrofit values).
--
-- See: docs/plans/2026-04-25-paychex-integration-plan.md
--      ("Updates to organizations.settings").

UPDATE public.organizations
SET settings = settings
  || jsonb_build_object(
       'paychex', jsonb_build_object(
         'display_id',              '70125496',
         'company_id',              '00M9LQF7LUBLSED1THE0',
         'company_display',         '70125496 - TREMENDOUS CARE',
         'pay_period', jsonb_build_object(
           'frequency', 'weekly',
           'ends_on',   'sunday',
           'pay_day',   'wednesday'
         ),
         'default_employment_type', 'FULL_TIME',
         'default_exemption_type',  'NON_EXEMPT'
       ),
       'payroll', jsonb_build_object(
         'mileage_rate',                            0.725,
         'ot_jurisdiction',                         'CA',
         'timezone',                                'America/Los_Angeles',
         'default_work_state',                      'CA',
         'default_pending_hire_date_offset_days',   14
       )
     )
  || jsonb_build_object(
       'features_enabled',
       COALESCE(settings -> 'features_enabled', '{}'::jsonb)
         || jsonb_build_object('payroll', true)
     ),
    updated_at = now()
WHERE slug = 'tremendous-care';
