-- Rollback for exec_seed_templates.
--
-- Removes the 25 seeded executive task templates by slug. Any
-- exec_tasks rows generated from these templates have
-- template_id ON DELETE SET NULL so they are NOT cascade-deleted,
-- but they will lose their template linkage. The owner should
-- archive or delete those instances manually if desired.

DELETE FROM public.exec_task_templates
 WHERE slug IN (
   'monthly_pl_review',
   'monthly_cash_position',
   'monthly_ar_aging',
   'quarterly_tax_estimate',
   'quarterly_vendor_spend_audit',
   'annual_budget_planning',
   'annual_audit_prep',
   'annual_insurance_renewals',
   'annual_hipaa_risk_assessment',
   'annual_baa_renewals',
   'annual_state_license_renewal',
   'annual_dol_posters_refresh',
   'annual_handbook_review',
   'hire_30_day_checkin',
   'hire_60_day_checkin',
   'hire_90_day_checkin',
   'anniversary_review',
   'quarterly_comp_benchmarking',
   'quarterly_org_chart_review',
   'weekly_owner_1on1',
   'quarterly_okr_setting',
   'quarterly_okr_retrospective',
   'annual_strategy_offsite',
   'monthly_subscription_audit',
   'quarterly_security_advisor_review'
 );
