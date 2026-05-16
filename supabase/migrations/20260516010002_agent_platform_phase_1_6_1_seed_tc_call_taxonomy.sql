-- Phase 1.6.1 — seed Tremendous Care's initial call_taxonomy rows.
--
-- Seven call_types + eight red_flags, locked with the owner on
-- 2026-05-16. Operators can edit / archive any of these via the
-- Settings UI immediately after this migration ships. The agent
-- prompt in Phase 1.6.2 references rows by slug; renaming slugs
-- here would break that reference, so renaming should be rare.
--
-- Idempotent: `ON CONFLICT (org_id, axis, slug) DO NOTHING` so the
-- seed can be re-run without clobbering operator edits. Owners who
-- want to "reset to factory" would delete rows manually first.
--
-- Locked to Tremendous Care's org via `default_org_id()`. Phase D's
-- multi-tenant onboarding will need a parallel seed per new org;
-- that work lives in the onboarding flow, not this migration.

INSERT INTO public.call_taxonomy (org_id, axis, slug, label, description, sort_order, is_active)
VALUES
  -- Call types — what kind of conversation this is.
  (public.default_org_id(), 'call_type', 'recruiting',   'Recruiting',   'Outreach, interview, or onboarding conversation with a prospective or current caregiver applicant.', 10, true),
  (public.default_org_id(), 'call_type', 'client_care',  'Client care',  'Operational call with or about an active client — care plan check-in, visit confirmation, family update.',        20, true),
  (public.default_org_id(), 'call_type', 'bd_outreach',  'BD outreach',  'Business-development call with a referral source (case manager, hospital, community partner).',                  30, true),
  (public.default_org_id(), 'call_type', 'payroll',      'Payroll',      'Payroll / timesheet question from a caregiver or finance partner.',                                              40, true),
  (public.default_org_id(), 'call_type', 'scheduling',   'Scheduling',   'Shift swap, callout, availability change, last-minute cover.',                                                   50, true),
  (public.default_org_id(), 'call_type', 'complaint',    'Complaint',    'Inbound complaint requiring escalation — billing dispute, care-quality concern, behaviour issue.',               60, true),
  (public.default_org_id(), 'call_type', 'other',        'Other',        'Anything not covered by the above. Operators can re-classify in the UI.',                                        99, true),

  -- Red flag categories — risks the agent should surface to operators.
  (public.default_org_id(), 'red_flag', 'compliance_concern',   'Compliance concern',     'HCA mention near expiry, missing background-check follow-up, license question, training lapse.', 10, true),
  (public.default_org_id(), 'red_flag', 'safety_issue',         'Safety issue',           'Caregiver mentions feeling unsafe at a client home; client mentions concerning caregiver behaviour.', 20, true),
  (public.default_org_id(), 'red_flag', 'client_dissatisfaction','Client dissatisfaction', 'Negative feedback about a caregiver, complaint about scheduling, request to switch.',           30, true),
  (public.default_org_id(), 'red_flag', 'caregiver_distress',   'Caregiver distress',     'Burnout signals, medical issues, personal hardship affecting work.',                              40, true),
  (public.default_org_id(), 'red_flag', 'payment_dispute',      'Payment / pay dispute',  'Caregiver disputes hours, missing paychecks, billing complaint from client.',                     50, true),
  (public.default_org_id(), 'red_flag', 'legal_or_hr_risk',     'Legal / HR risk',        'Threats of legal action, harassment allegation, workers'' comp incident.',                        60, true),
  (public.default_org_id(), 'red_flag', 'urgent_scheduling_gap','Urgent scheduling gap',  'Shift uncovered, client without coverage, last-minute cancellation.',                              70, true),
  (public.default_org_id(), 'red_flag', 'other',                'Other',                  'Anything else worth flagging. Operators can rename or split in the UI.',                          99, true)
ON CONFLICT (org_id, axis, slug) DO NOTHING;

-- Sanity check: confirm the seed landed (or was already present from a
-- prior run). 7 call_types + 8 red_flags = 15 rows for Tremendous Care.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.call_taxonomy
   WHERE org_id = public.default_org_id();

  IF v_count < 15 THEN
    RAISE EXCEPTION
      'call_taxonomy seed incomplete: expected ≥ 15 rows for Tremendous Care, found %', v_count;
  END IF;
END
$$;
