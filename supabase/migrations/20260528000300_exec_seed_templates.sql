-- ═══════════════════════════════════════════════════════════════
-- Executive Task Management — Phase 1 PR 1, Migration 4 of 4
--
-- Seeds 25 executive task templates organized into five buckets:
--   • Financial (8 templates)
--   • Compliance (5 templates)
--   • People (6 templates)
--   • Strategic (4 templates)
--   • Operational (2 templates)
--
-- All seeded as active=false so they show up in the Templates UI
-- but do not start generating tasks until the owner toggles them
-- on. This is the agreed-on safety: owner reviews the wording,
-- structured questions, and timing before any of these land on the
-- dashboard.
--
-- Anchoring conventions used in this seed:
--   • Lifecycle (anchor_type='hire_date'): offset_days set; the
--     Phase 3 generator will spawn one instance per active
--     staff_members row at hire_date + offset_days.
--   • Recurring (anchor_type='fixed_date'): recurrence_interval_days
--     set; the generator bumps next_fire_at by that many days each
--     time it fires. Approximate-but-good-enough cadences:
--        weekly    =   7 days
--        monthly   =  30 days
--        quarterly =  90 days
--        annual    = 365 days
--     Phase 3 can swap to true cron expressions if precision matters
--     for a given template; the schema supports adding a column
--     non-destructively.
--   • Manual (anchor_type='manual'): owner creates ad-hoc.
--
-- structured_questions:
--   Each template defines its check-in form as an ordered JSONB
--   array. Schema per element:
--     { id: text,                  // stable key, used in responses
--       label: text,               // displayed prompt
--       type: text,                // 'rating_1_5' | 'short_text' |
--                                  //  'long_text' | 'yes_no' |
--                                  //  'single_select' | 'number' |
--                                  //  'date'
--       options?: text[],          // required when type='single_select'
--       required?: boolean }       // defaults to false
--
-- Idempotent: UNIQUE (org_id, slug) + ON CONFLICT DO NOTHING. If
-- the owner has already edited a template's wording, re-running
-- this migration WILL NOT clobber their edits.
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- FINANCIAL (8 templates)
-- ────────────────────────────────────────────────────────────────────

-- 1. Monthly P&L review
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'monthly_pl_review',
       'Monthly P&L review',
       'Review profit & loss statement for the prior month.',
       'Pull the P&L from QuickBooks (or your accountant). Compare revenue and expenses to plan. Note any large variances and what drove them. The structured questions become your monthly financial commentary file.',
       'recurring', 'fixed_date', 30,
       '[
          {"id":"revenue_actual","label":"Revenue actual ($)","type":"number","required":true},
          {"id":"revenue_variance_pct","label":"Revenue variance vs target (%)","type":"number","required":false},
          {"id":"gross_margin_pct","label":"Gross margin (%)","type":"number","required":true},
          {"id":"top_variance_driver","label":"Largest variance driver (positive or negative)","type":"long_text","required":true},
          {"id":"cash_position_eom","label":"Cash position at month-end ($)","type":"number","required":true},
          {"id":"action_items","label":"Action items for next month","type":"long_text","required":false}
        ]'::jsonb,
       'critical', 'owner', false, 110
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 2. Monthly cash position check
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'monthly_cash_position',
       'Monthly cash position check',
       'Mid-month cash check to spot runway issues before they bite.',
       'How many weeks of operating runway do you have at current burn? Are any large AR balances aging out? Any upcoming large payments (payroll, insurance, taxes) that need cash reserved?',
       'recurring', 'fixed_date', 30,
       '[
          {"id":"cash_on_hand","label":"Cash on hand ($)","type":"number","required":true},
          {"id":"weeks_runway","label":"Weeks of operating runway","type":"number","required":true},
          {"id":"upcoming_large_payments","label":"Large payments due in next 30 days","type":"long_text","required":false},
          {"id":"concerns","label":"Concerns or risks","type":"long_text","required":false}
        ]'::jsonb,
       'warning', 'owner', false, 120
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 3. Monthly AR aging review
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'monthly_ar_aging',
       'Monthly AR aging review',
       'Review accounts-receivable aging and collection actions.',
       'Pull AR aging from your billing system. Anything 60+ days overdue gets a call or escalation. Long-tail uncollectibles get written off so the AR balance reflects reality.',
       'recurring', 'fixed_date', 30,
       '[
          {"id":"total_ar","label":"Total AR ($)","type":"number","required":true},
          {"id":"ar_over_60","label":"AR over 60 days ($)","type":"number","required":true},
          {"id":"escalations","label":"Accounts requiring escalation","type":"long_text","required":false},
          {"id":"writeoffs","label":"Recommended write-offs","type":"long_text","required":false}
        ]'::jsonb,
       'warning', 'owner', false, 130
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 4. Quarterly tax estimate filing
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'quarterly_tax_estimate',
       'Quarterly tax estimate filing',
       'Confirm quarterly estimated taxes are filed (federal + state).',
       'IRS quarterly deadlines: Apr 15, Jun 15, Sep 15, Jan 15. CA FTB matches federal. Confirm your accountant filed (or DIY through EFTPS) and record the amount.',
       'recurring', 'fixed_date', 90,
       '[
          {"id":"federal_amount","label":"Federal estimate paid ($)","type":"number","required":true},
          {"id":"state_amount","label":"State estimate paid ($)","type":"number","required":true},
          {"id":"confirmation_ref","label":"Confirmation reference","type":"short_text","required":true}
        ]'::jsonb,
       'critical', 'owner', false, 140
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 5. Quarterly vendor spend audit
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'quarterly_vendor_spend_audit',
       'Quarterly vendor spend audit',
       'Review all vendor spend; cancel what we no longer use.',
       'Pull all recurring vendor charges. Anything we are not actively using gets cancelled. Anything we could renegotiate gets flagged. Software-bloat is the quiet killer.',
       'recurring', 'fixed_date', 90,
       '[
          {"id":"vendors_reviewed","label":"Number of vendors reviewed","type":"number","required":true},
          {"id":"cancellations","label":"Vendors cancelled","type":"long_text","required":false},
          {"id":"renegotiations","label":"Vendors to renegotiate","type":"long_text","required":false},
          {"id":"monthly_savings","label":"Estimated monthly savings ($)","type":"number","required":false}
        ]'::jsonb,
       'info', 'owner', false, 150
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 6. Annual budget planning
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'annual_budget_planning',
       'Annual budget planning',
       'Build next year''s operating budget.',
       'Three-statement build: revenue forecast (by client + new business), expense plan (headcount, software, insurance, rent), cash flow. Compare against this year actuals. Plan for two scenarios (base and downside).',
       'recurring', 'fixed_date', 365,
       '[
          {"id":"revenue_target","label":"Next year revenue target ($)","type":"number","required":true},
          {"id":"expense_plan","label":"Next year expense plan ($)","type":"number","required":true},
          {"id":"projected_margin","label":"Projected margin (%)","type":"number","required":true},
          {"id":"key_assumptions","label":"Key assumptions","type":"long_text","required":true},
          {"id":"downside_plan","label":"Downside scenario plan","type":"long_text","required":false}
        ]'::jsonb,
       'critical', 'owner', false, 160
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 7. Annual audit prep
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'annual_audit_prep',
       'Annual audit / tax prep',
       'Prepare books and records for annual tax filing or audit.',
       'Close out the prior year in QuickBooks. Reconcile all bank accounts to year-end statements. Prepare 1099s for contractors. Hand-off package to CPA includes: P&L, balance sheet, GL detail, bank recs, fixed asset roll-forward.',
       'recurring', 'fixed_date', 365,
       '[
          {"id":"books_closed","label":"Books closed and reconciled?","type":"yes_no","required":true},
          {"id":"1099s_sent","label":"1099s sent to contractors?","type":"yes_no","required":true},
          {"id":"cpa_handoff_date","label":"CPA handoff date","type":"date","required":true},
          {"id":"open_items","label":"Open items / follow-ups","type":"long_text","required":false}
        ]'::jsonb,
       'critical', 'owner', false, 170
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 8. Annual insurance renewals
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'annual_insurance_renewals',
       'Annual insurance renewals',
       'Review and renew all business insurance policies.',
       'Workers comp, general liability, professional liability, cyber, EPLI, auto if applicable. Get 2-3 quotes for the larger lines every year. Confirm coverage limits still match your scale.',
       'recurring', 'fixed_date', 365,
       '[
          {"id":"policies_reviewed","label":"Policies reviewed","type":"long_text","required":true},
          {"id":"total_annual_premium","label":"Total annual premium ($)","type":"number","required":true},
          {"id":"coverage_changes","label":"Coverage changes from prior year","type":"long_text","required":false},
          {"id":"quotes_obtained","label":"Number of competing quotes obtained","type":"number","required":false}
        ]'::jsonb,
       'critical', 'owner', false, 180
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────
-- COMPLIANCE (5 templates)
-- ────────────────────────────────────────────────────────────────────

-- 9. Annual HIPAA risk assessment
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'annual_hipaa_risk_assessment',
       'Annual HIPAA risk assessment',
       'Conduct annual HIPAA security risk assessment.',
       'HHS-mandated for covered entities. Document threats, vulnerabilities, current safeguards, and remediation plan. Use the HHS Security Risk Assessment Tool or a HIPAA consultant. Keep the written report for 6 years.',
       'recurring', 'fixed_date', 365,
       '[
          {"id":"assessment_completed_date","label":"Assessment completion date","type":"date","required":true},
          {"id":"high_risks","label":"High-priority risks identified","type":"long_text","required":true},
          {"id":"remediation_plan","label":"Remediation plan","type":"long_text","required":true},
          {"id":"assessor","label":"Assessor (internal or external firm)","type":"short_text","required":true}
        ]'::jsonb,
       'critical', 'owner', false, 210
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 10. Annual BAA renewals
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'annual_baa_renewals',
       'Annual BAA renewals',
       'Verify all Business Associate Agreements are current.',
       'List every vendor that touches PHI: EHR, billing, IT support, telehealth, file storage. Confirm BAA is on file and not expired. Any new vendor added this year needs one before they go live.',
       'recurring', 'fixed_date', 365,
       '[
          {"id":"vendors_with_baa","label":"Vendors with current BAA","type":"long_text","required":true},
          {"id":"vendors_missing_baa","label":"Vendors missing or expired BAA","type":"long_text","required":false},
          {"id":"baas_renewed_count","label":"BAAs renewed this cycle","type":"number","required":false}
        ]'::jsonb,
       'critical', 'owner', false, 220
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 11. Annual state home-care license renewal
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'annual_state_license_renewal',
       'Annual state license renewal',
       'Renew the home care organization license with the state.',
       'In California: HCSB renewal through CDSS. Confirm filing fee, insurance certificate, and any required reports are current. Late renewals can suspend operations.',
       'recurring', 'fixed_date', 365,
       '[
          {"id":"renewal_filed_date","label":"Renewal filing date","type":"date","required":true},
          {"id":"license_expires","label":"New expiration date","type":"date","required":true},
          {"id":"renewal_fee","label":"Fee paid ($)","type":"number","required":false},
          {"id":"confirmation_ref","label":"Confirmation reference","type":"short_text","required":false}
        ]'::jsonb,
       'critical', 'owner', false, 230
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 12. Annual DOL posters refresh
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'annual_dol_posters_refresh',
       'Annual DOL labor posters refresh',
       'Order and post current-year federal + state labor law posters.',
       'Federal (FLSA, FMLA, OSHA, EEO, polygraph) + state (CA: wage order, harassment, etc.). Order replacements from a poster service or print from DOL.gov. Confirm posting at every physical office location.',
       'recurring', 'fixed_date', 365,
       '[
          {"id":"federal_posted","label":"Federal posters posted?","type":"yes_no","required":true},
          {"id":"state_posted","label":"State posters posted?","type":"yes_no","required":true},
          {"id":"locations","label":"Locations posted","type":"short_text","required":false}
        ]'::jsonb,
       'warning', 'owner', false, 240
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 13. Annual employee handbook review
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'annual_handbook_review',
       'Annual employee handbook review',
       'Review and update employee handbook for legal + policy changes.',
       'CA labor law changes annually. Have an HR attorney or service (Mineral, Bambee, etc.) review. Republish to all staff and capture signed acknowledgment.',
       'recurring', 'fixed_date', 365,
       '[
          {"id":"reviewed_by","label":"Reviewed by (firm or person)","type":"short_text","required":true},
          {"id":"changes_made","label":"Major changes this cycle","type":"long_text","required":false},
          {"id":"staff_acknowledged","label":"All staff signed updated handbook?","type":"yes_no","required":true}
        ]'::jsonb,
       'warning', 'owner', false, 250
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────
-- PEOPLE (6 templates)
-- ────────────────────────────────────────────────────────────────────

-- 14. 30-day check-in (lifecycle)
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, offset_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'hire_30_day_checkin',
       '30-day check-in',
       'Structured check-in 30 days after a new hire''s start date.',
       'Sit down with the new hire for 30 minutes. Use the structured questions as a guide. The goal is to surface ramp issues, blockers, and culture-fit signals before they become problems.',
       'lifecycle', 'hire_date', 30,
       '[
          {"id":"ramp_rating","label":"Ramp vs expectations (1=behind, 5=ahead)","type":"rating_1_5","required":true},
          {"id":"going_well","label":"What''s going well?","type":"long_text","required":true},
          {"id":"blocking","label":"What''s blocking them?","type":"long_text","required":true},
          {"id":"concerns","label":"Any concerns?","type":"yes_no","required":true},
          {"id":"concerns_detail","label":"If concerns, describe","type":"long_text","required":false},
          {"id":"on_track_60","label":"On track for 60-day milestone?","type":"single_select","options":["on_track","at_risk","off_track"],"required":true}
        ]'::jsonb,
       'critical', 'owner', false, 310
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 15. 60-day check-in (lifecycle)
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, offset_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'hire_60_day_checkin',
       '60-day check-in',
       'Structured check-in 60 days after a new hire''s start date.',
       'Halfway to the 90-day decision. Has the ramp accelerated or stalled since the 30-day? Has the role scope clarified? Are responsibilities being met independently?',
       'lifecycle', 'hire_date', 60,
       '[
          {"id":"ramp_rating","label":"Ramp vs expectations (1-5)","type":"rating_1_5","required":true},
          {"id":"progress_since_30","label":"Progress since 30-day","type":"single_select","options":["improved","same","declined"],"required":true},
          {"id":"strengths","label":"Demonstrated strengths","type":"long_text","required":true},
          {"id":"gaps","label":"Gaps or development areas","type":"long_text","required":true},
          {"id":"on_track_90","label":"On track for 90-day milestone?","type":"single_select","options":["on_track","at_risk","off_track"],"required":true}
        ]'::jsonb,
       'critical', 'owner', false, 320
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 16. 90-day check-in (lifecycle) — decision point
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, offset_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'hire_90_day_checkin',
       '90-day check-in (probation decision)',
       'End-of-probation review with continue/PIP/separate decision.',
       'This is the real decision point. Be honest with yourself: would you re-hire this person knowing what you know now? If not, separate now or document a Performance Improvement Plan with clear 30-day goals.',
       'lifecycle', 'hire_date', 90,
       '[
          {"id":"ramp_rating","label":"Final probationary ramp rating (1-5)","type":"rating_1_5","required":true},
          {"id":"key_wins","label":"Key wins during probation","type":"long_text","required":true},
          {"id":"key_concerns","label":"Key concerns","type":"long_text","required":false},
          {"id":"decision","label":"Continue past probation?","type":"single_select","options":["yes","yes_with_pip","no"],"required":true},
          {"id":"pip_details","label":"If PIP, detail goals + 30-day timeline","type":"long_text","required":false},
          {"id":"comp_change","label":"Comp change at probation end?","type":"short_text","required":false}
        ]'::jsonb,
       'critical', 'owner', false, 330
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 17. Anniversary review (lifecycle)
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, offset_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'anniversary_review',
       'Anniversary review',
       'Annual review on each staff member''s hire-date anniversary.',
       'Year-in-review conversation. What did they accomplish? What growth happened? What''s next? Comp + title conversation if applicable. Document so next year''s review has a starting point.',
       'lifecycle', 'hire_date', 365,
       '[
          {"id":"overall_rating","label":"Overall performance (1-5)","type":"rating_1_5","required":true},
          {"id":"top_accomplishments","label":"Top accomplishments this year","type":"long_text","required":true},
          {"id":"growth_areas","label":"Growth areas for next year","type":"long_text","required":true},
          {"id":"comp_change","label":"Comp change","type":"short_text","required":false},
          {"id":"retention_risk","label":"Retention risk","type":"single_select","options":["low","medium","high"],"required":true},
          {"id":"goals_next_year","label":"Goals for next 12 months","type":"long_text","required":true}
        ]'::jsonb,
       'warning', 'owner', false, 340
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 18. Quarterly comp benchmarking
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'quarterly_comp_benchmarking',
       'Quarterly comp benchmarking',
       'Confirm staff and caregiver comp is competitive with market.',
       'Look at local caregiver wage trends (state min wage changes, competitor postings). For salaried staff, refresh against role-level benchmarks. If anyone is materially under market, plan a raise before they leave.',
       'recurring', 'fixed_date', 90,
       '[
          {"id":"caregiver_rate_pos","label":"Caregiver rate position vs market","type":"single_select","options":["above","at","below"],"required":true},
          {"id":"staff_pos","label":"Staff comp position vs market","type":"single_select","options":["above","at","below"],"required":true},
          {"id":"raises_planned","label":"Raises planned","type":"long_text","required":false},
          {"id":"flight_risks","label":"Flight risks identified","type":"long_text","required":false}
        ]'::jsonb,
       'warning', 'owner', false, 350
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 19. Quarterly org chart review
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'quarterly_org_chart_review',
       'Quarterly org chart review',
       'Confirm the org chart reflects reality and identifies gaps.',
       'Who reports to whom right now? Are roles clear? Where are we one-deep on critical responsibilities (bus factor = 1)? What hires do we need to plan for in the next 6 months?',
       'recurring', 'fixed_date', 90,
       '[
          {"id":"structure_changes","label":"Structural changes since last review","type":"long_text","required":false},
          {"id":"bus_factor_risks","label":"Roles where bus factor = 1","type":"long_text","required":true},
          {"id":"planned_hires","label":"Planned hires next 6 months","type":"long_text","required":true},
          {"id":"role_clarity","label":"Roles where clarity needs work","type":"long_text","required":false}
        ]'::jsonb,
       'info', 'owner', false, 360
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────
-- STRATEGIC (4 templates)
-- ────────────────────────────────────────────────────────────────────

-- 20. Weekly owner 1:1 (Kevin <> Blerta)
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'weekly_owner_1on1',
       'Weekly owner 1:1',
       'Recurring weekly sync between owners.',
       '30-60 minutes. Walk the goal dashboard, walk the watchlist, agree on the week''s top 3 priorities. Capture decisions so the rest of the team can act.',
       'recurring', 'fixed_date', 7,
       '[
          {"id":"top_3_priorities","label":"Top 3 priorities for the coming week","type":"long_text","required":true},
          {"id":"decisions","label":"Decisions made","type":"long_text","required":false},
          {"id":"blockers","label":"Blockers needing follow-up","type":"long_text","required":false}
        ]'::jsonb,
       'warning', 'owner', false, 410
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 21. Quarterly OKR setting
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'quarterly_okr_setting',
       'Quarterly OKR setting',
       'Set 3-5 Objectives and 2-4 Key Results each for the coming quarter.',
       'Use the Executive → Goals page to enter the new quarter''s objectives and KRs. Aim ambitious-but-credible (70% achievement is the OKR sweet spot). Assign one owner per objective.',
       'recurring', 'fixed_date', 90,
       '[
          {"id":"num_objectives","label":"Number of objectives set","type":"number","required":true},
          {"id":"theme","label":"Theme / strategic priority for the quarter","type":"long_text","required":true},
          {"id":"all_objectives_have_owners","label":"All objectives assigned to an owner?","type":"yes_no","required":true}
        ]'::jsonb,
       'critical', 'owner', false, 420
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 22. Quarterly OKR retrospective
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'quarterly_okr_retrospective',
       'Quarterly OKR retrospective',
       'Score the prior quarter''s OKRs and learn from misses.',
       'Walk each KR: what was the final value, did we hit target, what did we learn? Score honestly. Set status to achieved / missed / cancelled on each goal.',
       'recurring', 'fixed_date', 90,
       '[
          {"id":"avg_kr_score","label":"Average KR achievement (%)","type":"number","required":true},
          {"id":"top_wins","label":"Biggest wins","type":"long_text","required":true},
          {"id":"top_misses","label":"Biggest misses and why","type":"long_text","required":true},
          {"id":"lessons","label":"Lessons for next quarter","type":"long_text","required":true}
        ]'::jsonb,
       'critical', 'owner', false, 430
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 23. Annual strategy offsite
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'annual_strategy_offsite',
       'Annual strategy offsite',
       'Full-day owner offsite to set the year''s direction.',
       'Away from the office, phones off. Review the prior year, debate the next 12-36 months, set the annual theme. Document outputs so they inform every quarterly OKR cycle.',
       'recurring', 'fixed_date', 365,
       '[
          {"id":"annual_theme","label":"Annual theme","type":"long_text","required":true},
          {"id":"top_3_bets","label":"Top 3 bets for the year","type":"long_text","required":true},
          {"id":"things_to_stop","label":"Things we will stop doing","type":"long_text","required":false},
          {"id":"3_year_horizon","label":"3-year horizon view","type":"long_text","required":false}
        ]'::jsonb,
       'critical', 'owner', false, 440
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────
-- OPERATIONAL (2 templates)
-- ────────────────────────────────────────────────────────────────────

-- 24. Monthly subscription audit
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'monthly_subscription_audit',
       'Monthly software subscription audit',
       'Walk all software subscription charges; cancel zombie tools.',
       'Pull the credit-card statement; identify every software charge. Match each one to an active user/use case. Cancel zombies. Catches drift before it adds up.',
       'recurring', 'fixed_date', 30,
       '[
          {"id":"subscriptions_count","label":"Active subscriptions","type":"number","required":true},
          {"id":"monthly_subscription_spend","label":"Monthly subscription spend ($)","type":"number","required":true},
          {"id":"cancellations","label":"Cancelled this month","type":"long_text","required":false}
        ]'::jsonb,
       'info', 'owner', false, 510
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- 25. Quarterly security advisor review
INSERT INTO public.exec_task_templates
  (org_id, slug, name, description, guidance, category,
   anchor_type, recurrence_interval_days, structured_questions,
   default_urgency, visibility, active, sort_order)
SELECT o.id, 'quarterly_security_advisor_review',
       'Quarterly security advisor review',
       'Review Supabase / infrastructure security advisors and access lists.',
       'In Supabase Dashboard, walk the Advisors panel and resolve any open security findings. Audit Vercel and GitHub access lists; remove anyone who shouldn''t still have it. Rotate any keys that have been around > 1 year.',
       'recurring', 'fixed_date', 90,
       '[
          {"id":"open_advisors","label":"Open Supabase advisor findings","type":"number","required":true},
          {"id":"access_changes","label":"Access changes made","type":"long_text","required":false},
          {"id":"keys_rotated","label":"Keys rotated","type":"long_text","required":false}
        ]'::jsonb,
       'warning', 'owner', false, 520
FROM public.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────
-- Sanity check
-- ────────────────────────────────────────────────────────────────────
-- Expect 25 templates per org (Tremendous Care and any acme-test).

DO $$
DECLARE
  v_count integer;
  v_org_id uuid;
BEGIN
  v_org_id := public.default_org_id();
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'exec_seed_templates: default_org_id() NULL; skipping count check';
    RETURN;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.exec_task_templates
   WHERE org_id = v_org_id;

  IF v_count < 25 THEN
    RAISE NOTICE
      'exec_seed_templates: expected >= 25 templates for default org, found % (some may be pre-edited and skipped via ON CONFLICT)',
      v_count;
  END IF;
END
$$;
