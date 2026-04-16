
-- Action Item Rules: configurable rules that drive the dashboard "Today's Action Items" panels
CREATE TABLE IF NOT EXISTS action_item_rules (
  id text PRIMARY KEY,
  name text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('caregiver', 'client')),
  condition_type text NOT NULL CHECK (condition_type IN ('phase_time', 'task_incomplete', 'task_stale', 'date_expiring', 'time_since_creation', 'last_note_stale', 'sprint_deadline')),
  condition_config jsonb NOT NULL DEFAULT '{}',
  urgency text NOT NULL CHECK (urgency IN ('critical', 'warning', 'info')),
  urgency_escalation jsonb DEFAULT NULL,
  icon text NOT NULL DEFAULT '📋',
  title_template text NOT NULL,
  detail_template text NOT NULL DEFAULT '',
  action_template text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- RLS: all authenticated can read, admins can write
ALTER TABLE action_item_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read action_item_rules"
  ON action_item_rules FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can insert action_item_rules"
  ON action_item_rules FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE email = auth.jwt() ->> 'email' AND role = 'admin')
  );

CREATE POLICY "Admins can update action_item_rules"
  ON action_item_rules FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_roles WHERE email = auth.jwt() ->> 'email' AND role = 'admin')
  );

CREATE POLICY "Admins can delete action_item_rules"
  ON action_item_rules FOR DELETE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM user_roles WHERE email = auth.jwt() ->> 'email' AND role = 'admin')
  );

-- ═══════════════════════════════════════════════════════════════
-- Seed data: all 19 existing hardcoded rules
-- Uses ON CONFLICT DO NOTHING so re-running is safe
-- ═══════════════════════════════════════════════════════════════

-- ── Caregiver Rules (13) ──

INSERT INTO action_item_rules (id, name, entity_type, condition_type, condition_config, urgency, urgency_escalation, icon, title_template, detail_template, action_template, sort_order) VALUES

-- 1. Interview not scheduled (24hr standard)
('cg_interview_not_scheduled', '24-Hour Interview Standard', 'caregiver', 'task_incomplete',
 '{"task_id": "calendar_invite", "phase": "intake", "min_days": 1}',
 'warning', '{"min_days": 2, "urgency": "critical"}',
 '🕐', 'Interview not yet scheduled',
 'Day {{days_since_created}} — Goal is application to interview within 24 hours.',
 'Schedule virtual interview now', 10),

-- 2. Offer letter chase (Day 2 warning)
('cg_offer_letter_warning', 'Offer Letter Chase (Warning)', 'caregiver', 'task_stale',
 '{"done_task_id": "offer_letter_sent", "pending_task_id": "offer_hold", "phase": "interview", "min_days": 2}',
 'warning', '{"min_days": 3, "urgency": "critical"}',
 '📝', 'Offer letter unsigned — Day {{days_in_phase}}',
 '"We cannot proceed without this."',
 'Call + text follow-up', 20),

-- 3. Onboarding sprint (Day 3-4 warning)
('cg_onboarding_sprint_warning', 'Onboarding Docs Incomplete', 'caregiver', 'sprint_deadline',
 '{"phase": "onboarding", "warning_day": 3, "critical_day": 5, "expired_day": 7}',
 'warning', null,
 '📋', 'Onboarding docs incomplete — Day {{sprint_day}}',
 '{{sprint_remaining}} days remaining in the 7-day sprint.',
 'Follow up: "Do you have any questions?"', 30),

-- 4. Onboarding sprint (Day 5-6 critical)
('cg_onboarding_sprint_critical', 'Onboarding Deadline Approaching', 'caregiver', 'sprint_deadline',
 '{"phase": "onboarding", "warning_day": 5, "critical_day": 5, "expired_day": 7}',
 'critical', null,
 '⏰', 'Onboarding deadline in {{sprint_remaining}} day(s)',
 'Day {{sprint_day}} of 7 — "Are you free now? I can help you on the phone."',
 'The Intervention: call and offer to help complete docs', 31),

-- 5. Onboarding sprint EXPIRED (Day 7+)
('cg_onboarding_sprint_expired', '7-Day Sprint EXPIRED', 'caregiver', 'sprint_deadline',
 '{"phase": "onboarding", "warning_day": 7, "critical_day": 7, "expired_day": 7}',
 'critical', null,
 '🚨', '7-Day Sprint EXPIRED',
 'Day {{sprint_day}} of onboarding — policy is to retract offer.',
 'Retract offer or escalate to management', 32),

-- 6. Verification stall
('cg_verification_stall', 'Verification Pending', 'caregiver', 'phase_time',
 '{"phase": "verification", "min_days": 3}',
 'warning', '{"min_days": 5, "urgency": "critical"}',
 '✅', 'Verification pending — Day {{days_in_phase}}',
 'Check: I-9 validation, HCA Guardian status, CareAcademy, WellSky entry.',
 'Complete remaining verification items', 40),

-- 7. Orientation invite not sent
('cg_orientation_invite', 'Orientation Invite Not Sent', 'caregiver', 'task_incomplete',
 '{"task_id": "invite_sent", "phase": "orientation", "min_days": 1}',
 'warning', null,
 '🎓', 'Orientation invite not sent',
 'Caregiver is ready — schedule for next Sunday orientation.',
 'Send calendar invite with instructions', 50),

-- 8. HCA expired
('cg_hca_expired', 'HCA Registration EXPIRED', 'caregiver', 'date_expiring',
 '{"field": "hcaExpiration", "days_until": -1}',
 'critical', null,
 '⚠️', 'HCA registration EXPIRED',
 'Expired {{days_until_expiry}} days ago. Caregiver cannot be deployed.',
 'Contact caregiver to renew HCA immediately', 60),

-- 9. HCA expiring (30 days)
('cg_hca_expiring_30', 'HCA Expiring Soon (30 days)', 'caregiver', 'date_expiring',
 '{"field": "hcaExpiration", "days_warning": 30}',
 'warning', null,
 '📅', 'HCA expiring in {{days_until_expiry}} days',
 'Expires {{expiry_date}}. Begin renewal process.',
 'Send HCA renewal reminder', 61),

-- 10. HCA expiring (90 days)
('cg_hca_expiring_90', 'HCA Expiring (90 days)', 'caregiver', 'date_expiring',
 '{"field": "hcaExpiration", "days_warning": 90, "days_exclude_under": 30}',
 'info', null,
 '📅', 'HCA expiring in {{days_until_expiry}} days',
 'Expires {{expiry_date}}. Plan ahead for renewal.',
 'Note for upcoming renewal', 62),

-- 11. Phone screen stall
('cg_phone_screen_stall', 'No Phone Screen', 'caregiver', 'task_incomplete',
 '{"task_id": "phone_screen", "phase": "intake", "min_days": 4}',
 'warning', null,
 '📞', 'No phone screen after {{days_in_phase}} days',
 'Candidate may be lost. Consider final outreach attempt.',
 'Day 5 final attempt or close out', 70)

ON CONFLICT (id) DO NOTHING;

-- ── Client Rules (6) ──

INSERT INTO action_item_rules (id, name, entity_type, condition_type, condition_config, urgency, icon, title_template, detail_template, action_template, sort_order) VALUES

-- 1. Speed to Lead
('cl_speed_to_lead', 'Speed to Lead', 'client', 'time_since_creation',
 '{"min_minutes": 30, "phase": "new_lead", "task_not_done": "initial_call_attempted"}',
 'critical',
 '🚨', 'Speed to Lead — {{minutes_since_created}} min',
 'New lead {{minutes_since_created}} minutes old — no initial call attempted. Goal: contact within 30 minutes.',
 'Make initial call immediately', 10),

-- 2. No Contact
('cl_no_contact', 'No Contact', 'client', 'phase_time',
 '{"phase": "initial_contact", "min_days": 2}',
 'warning',
 '📞', 'No live contact — Day {{days_in_phase}}',
 'Day {{days_in_phase}} in Initial Contact — still no live contact with decision-maker.',
 'Attempt live contact with decision-maker', 20),

-- 3. Assessment Overdue
('cl_assessment_overdue', 'Assessment Overdue', 'client', 'phase_time',
 '{"phase": "assessment", "min_days": 7}',
 'warning',
 '📋', 'Assessment overdue — Day {{days_in_phase}}',
 'Assessment phase open {{days_in_phase}} days — home visit may be delayed or needs rescheduling.',
 'Schedule or reschedule home visit', 30),

-- 4. Proposal Follow-up
('cl_proposal_followup', 'Proposal Follow-up', 'client', 'task_incomplete',
 '{"task_id": "proposal_followup", "phase": "proposal", "min_days": 3}',
 'warning',
 '📝', 'Proposal follow-up needed — Day {{days_in_phase}}',
 'Proposal sent {{days_in_phase}} days ago — follow-up call not completed.',
 'Complete follow-up call on proposal', 40),

-- 5. Stale Lead
('cl_stale_lead', 'Stale Lead', 'client', 'phase_time',
 '{"phase": "_any_active", "min_days": 14, "exclude_phases": ["won", "lost", "nurture"]}',
 'warning',
 '⏳', 'Stale lead — {{days_in_phase}} days',
 '{{days_in_phase}} days in {{phase_name}} phase — lead may be going cold.',
 'Follow-up or move to nurture', 50),

-- 6. Nurture Check
('cl_nurture_check', 'Nurture Check', 'client', 'last_note_stale',
 '{"min_days": 30, "phase": "nurture"}',
 'info',
 '💬', 'Nurture check-in overdue',
 '{{days_since_last_note}} days since last activity — time for a nurture check-in.',
 'Schedule nurture outreach', 60)

ON CONFLICT (id) DO NOTHING;
