-- Rollback for 20260516010002_agent_platform_phase_1_6_1_seed_tc_call_taxonomy.sql
--
-- Deletes only the seeded rows. Operator-edited rows (label /
-- description / sort_order / is_active changes) are kept — we identify
-- seeded rows by their slug list, not by created_at. Operator-added
-- rows (new slugs) are also kept.
--
-- This is intentional: a rollback of the seed should not destroy
-- operator data. If a full reset is needed, drop the table instead
-- (20260516010000_*_down.sql).

DELETE FROM public.call_taxonomy
 WHERE org_id = public.default_org_id()
   AND (
     (axis = 'call_type' AND slug IN (
       'recruiting', 'client_care', 'bd_outreach', 'payroll',
       'scheduling', 'complaint', 'other'
     ))
     OR
     (axis = 'red_flag' AND slug IN (
       'compliance_concern', 'safety_issue', 'client_dissatisfaction',
       'caregiver_distress', 'payment_dispute', 'legal_or_hr_risk',
       'urgent_scheduling_gap', 'other'
     ))
   );
