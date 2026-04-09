// ─── Pipeline Phases ─────────────────────────────────────────
export const PHASES = [
  {
    id: 'intake',
    label: 'Intake & Screen',
    short: 'Intake',
    icon: '📞',
    color: '#2E4E8D',
    description: 'Application received → Phone screen → Schedule interview',
  },
  {
    id: 'interview',
    label: 'Interview & Offer',
    short: 'Interview',
    icon: '🎥',
    color: '#29BEE4',
    description: 'Virtual interview → Decision → Verbal offer → DocuSign',
  },
  {
    id: 'onboarding',
    label: 'Onboarding Packet',
    short: 'Onboarding',
    icon: '📋',
    color: '#1084C3',
    description: 'DocuSign packet → Compliance docs → 7-day sprint',
  },
  {
    id: 'verification',
    label: 'Verification & Handoff',
    short: 'Verification',
    icon: '✅',
    color: '#3A6BA8',
    description: 'I-9 validation → HCA → CareAcademy → WellSky entry',
  },
  {
    id: 'orientation',
    label: 'Orientation',
    short: 'Orientation',
    icon: '🎓',
    color: '#0EA5C9',
    description: 'Calendar invite → Orientation day → First shift deployment',
  },
];

// ─── Default Phase Tasks ─────────────────────────────────────
export const DEFAULT_PHASE_TASKS = {
  intake: [
    { id: 'app_reviewed', label: 'Application reviewed within 30 minutes', critical: true },
    { id: 'survey_completed', label: 'Pre-screening survey completed' },
    { id: 'initial_contact', label: 'Initial contact attempted (Call/VM/Text/Indeed)' },
    { id: 'phone_screen', label: 'Phone screen conducted' },
    { id: 'registry_check', label: 'Registry check: HCA PER ID validated in Guardian' },
    { id: 'background_check', label: 'Background check initiated in Guardian' },
    { id: 'tb_test', label: 'TB test validated (negative, < 2 years)' },
    { id: 'certificates', label: 'CA training certificates validated with dates' },
    { id: 'shift_availability', label: 'Shift availability verified (days/times)' },
    { id: 'calendar_invite', label: 'Calendar invite sent with Zoom/Teams link' },
    { id: 'confirmation_email', label: 'Confirmation email sent to candidate & management' },
    { id: 'reminder_scheduled', label: 'Reminder email scheduled for interview day' },
  ],
  interview: [
    { id: 'interview_completed', label: 'Interview completed, scored, notes in ATS' },
    { id: 'decision_made', label: '"Green Light" confirmed by TMS/Management', critical: true },
    { id: 'verbal_offer', label: 'Verbal offer extended (rate confirmed with mgmt)' },
    { id: 'next_steps_discussed', label: 'Next steps & onboarding timeline discussed' },
    { id: 'offer_letter_sent', label: 'Offer letter sent via DocuSign', critical: true },
    { id: 'offer_hold', label: 'Hold: Do not proceed until offer is signed' },
  ],
  onboarding: [
    { id: 'offer_signed', label: 'Offer letter signed (within 24 hours)', critical: true },
    { id: 'wage_notice', label: 'Wage and Employment Notice' },
    { id: 'direct_deposit', label: 'Direct Deposit Authorization Form' },
    { id: 'i9_form', label: 'IRS I-9' },
    { id: 'w4_form', label: 'IRS W-4' },
    { id: 'emergency_contact', label: 'Employment Emergency Contact' },
    { id: 'employment_agreement', label: 'Employment Agreement' },
    { id: 'employee_handbook', label: 'Employee Handbook' },
    { id: 'harassment_pamphlet', label: 'CA Sexual Harassment Pamphlet (via Email)' },
    { id: 'disability_pamphlet', label: 'CA EDD Disability Insurance Pamphlet (via Email)' },
    { id: 'family_leave_pamphlet', label: 'CA EDD Paid Family Leave Pamphlet (via Email)' },
    { id: 'domestic_violence_notice', label: 'Domestic Violence Leave Notice (via Email)' },
  ],
  verification: [
    { id: 'i9_validation', label: 'I-9 validation conducted (virtual or in-person)', critical: true },
    { id: 'hca_linked', label: 'Caregiver linked to agency in Guardian' },
    { id: 'hca_cleared', label: 'HCA status confirmed "Cleared"', critical: true },
    { id: 'careacademy_entered', label: 'Entered into CareAcademy (PER ID + reg date)' },
    { id: 'training_assigned', label: '5 hours of training assigned/verified', critical: true },
    { id: 'wellsky_entered', label: 'Caregiver info entered in WellSky' },
    { id: 'docs_uploaded', label: 'ALL docs uploaded to WellSky "Files"' },
  ],
  orientation: [
    { id: 'orientation_confirmed', label: 'Caregiver confirmed attendance at next orientation', critical: true },
    { id: 'invite_sent', label: 'Calendar invite sent with clear instructions' },
    { id: 'wellsky_app_info', label: 'WellSky Personal Care App download info included' },
    { id: 'clock_expectation', label: 'Clock In/Out expectation set for orientation' },
    { id: 'reminder_sent', label: 'Reminder sent day before orientation' },
    { id: 'questionnaire_done', label: 'Orientation questionnaire completed' },
    { id: 'scrubs_distributed', label: 'Scrub top and gloves distributed' },
    { id: 'first_shift', label: 'First shift scheduled & client introduction confirmed', critical: true },
  ],
};

// ─── Chase Scripts ───────────────────────────────────────────
export const CHASE_SCRIPTS = {
  intake: {
    title: 'The Chase Protocol',
    scripts: [
      { day: 'Day 1', action: 'VM + Text + Indeed Message', script: 'Hi [Name], this is [Your Name] with Tremendous Care. I\'m calling regarding your application… I\'d love to chat more about your experience. Please call back at (949) 226-7908.' },
      { day: 'Day 2', action: 'Call + Text + VM', script: 'We are looking to fill day and night shifts and think you could be a great fit…' },
      { day: 'Day 3', action: 'Call only (No VM)', script: null },
      { day: 'Day 5', action: 'Final Attempt: Text + VM', script: 'Last follow-up regarding your application with Tremendous Care.' },
    ],
  },
  interview: {
    title: 'Verbal Offer Script',
    scripts: [
      { day: 'Offer', action: 'Verbal Offer', script: 'We\'d like to officially offer you the position! Pay rate is [$XX]. I\'m sending the Offer Letter via DocuSign now. Please sign within 24 hours so we can book your Orientation.' },
    ],
  },
  onboarding: {
    title: 'The Offer Letter Chase',
    scripts: [
      { day: 'Day 1', action: 'Send DocuSign + Text', script: 'Your offer letter has been sent via DocuSign. These take about 15-30 minutes to complete.' },
      { day: 'Day 2', action: 'Call + Text', script: 'Please complete by end of day to get matched with a client.' },
      { day: 'Day 3', action: 'Call + Text', script: 'Do you have any questions? We cannot proceed without this.' },
      { day: 'Day 4', action: 'The Intervention', script: 'I noticed you haven\'t finished. Are you free now? I can help you on the phone.' },
      { day: 'Day 7', action: '⚠️ DEADLINE', script: 'If incomplete → Retract Offer per company policy.' },
    ],
  },
};

// ─── Green Light Checklist ───────────────────────────────────
export const GREEN_LIGHT_ITEMS = [
  'Offer Letter Signed',
  'Onboarding Packet Complete (I-9, W-4, etc.)',
  'Background Check CLEARED in Guardian',
  'TB Test Valid (Negative < 2 years)',
  'CareAcademy Training Complete (5 hours)',
];

// ─── Default Board Columns ──────────────────────────────────
export const DEFAULT_BOARD_COLUMNS = [
  {
    id: 'ready',
    label: 'Ready for Deployment',
    icon: '🚀',
    color: '#2E4E8D',
    description: 'Orientation complete, awaiting first client match',
  },
  {
    id: 'deployed',
    label: 'Deployed',
    icon: '✅',
    color: '#16A34A',
    description: 'Currently assigned to a client',
  },
  {
    id: 'reserve',
    label: 'Reserve Pool / Last Resort',
    icon: '⏸️',
    color: '#D97706',
    description: 'Available but not first choice for assignments',
  },
  {
    id: 'revisit',
    label: 'Revisit Intermittently',
    icon: '🔄',
    color: '#8B5CF6',
    description: 'Check back periodically for availability or status change',
  },
];

// ─── Kanban UI Constants ────────────────────────────────────
export const COLUMN_ICONS = ['🚀', '✅', '⏸️', '🔄', '⭐', '📋', '🏠', '💼', '🔒', '📌', '🎯', '❄️', '🔥', '👥', '💤', '🚫'];
export const COLUMN_COLORS = ['#2E4E8D', '#29BEE4', '#1084C3', '#16A34A', '#D97706', '#8B5CF6', '#DC3545', '#0EA5C9', '#059669', '#7C3AED', '#DB2777', '#EA580C', '#4F46E5', '#0D9488'];

// ─── Default Board Labels ───────────────────────────────────
export const DEFAULT_BOARD_LABELS = [
  { id: 'urgent', name: 'Urgent', color: '#DC3545' },
  { id: 'bilingual', name: 'Bilingual', color: '#8B5CF6' },
  { id: 'live_in', name: 'Live-In OK', color: '#16A34A' },
  { id: 'experienced', name: 'Experienced (5+ yrs)', color: '#D97706' },
  { id: 'new_hire', name: 'New Hire', color: '#29BEE4' },
  { id: 'pending_docs', name: 'Pending Docs', color: '#EA580C' },
];

// ─── Label Colors (for label color picker) ──────────────────
export const LABEL_COLORS = [
  '#DC3545', '#EA580C', '#D97706', '#16A34A', '#059669',
  '#0EA5C9', '#29BEE4', '#2E4E8D', '#4F46E5', '#8B5CF6',
  '#DB2777', '#6B7280',
];

// ─── Document Types for SharePoint Integration ──────────────
// ─── DocuSign Envelope Statuses ─────────────────────────────
export const DOCUSIGN_STATUSES = {
  sent: { label: 'Sent', color: '#6B7280', bg: '#F3F4F6', border: '#D1D5DB' },
  delivered: { label: 'Delivered', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  viewed: { label: 'Viewed', color: '#A16207', bg: '#FFFBEB', border: '#FDE68A' },
  completed: { label: 'Completed', color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
  declined: { label: 'Declined', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
  voided: { label: 'Voided', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
};

// ─── eSignature Envelope Statuses ─────────────────────────────
export const ESIGN_STATUSES = {
  sent: { label: 'Sent', color: '#6B7280', bg: '#F3F4F6', border: '#D1D5DB' },
  viewed: { label: 'Viewed', color: '#A16207', bg: '#FFFBEB', border: '#FDE68A' },
  signed: { label: 'Signed', color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
  declined: { label: 'Declined', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
  expired: { label: 'Expired', color: '#9CA3AF', bg: '#F9FAFB', border: '#E5E7EB' },
  voided: { label: 'Voided', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
};

// ─── Document Types for SharePoint Integration ──────────────
export const DOCUMENT_TYPES = [
  { id: 'offer_signed', label: 'Offer Letter Signed', required: true },
  { id: 'wage_notice', label: 'Wage & Employment Notice', required: false },
  { id: 'direct_deposit', label: 'Direct Deposit Authorization Form', required: false },
  { id: 'i9_form', label: 'IRS I-9', required: true },
  { id: 'w4_form', label: 'IRS W-4', required: true },
  { id: 'emergency_contact', label: 'Employment Emergency Contact', required: true },
  { id: 'employment_agreement', label: 'Employment Agreement', required: true },
  { id: 'employee_handbook', label: 'Employee Handbook', required: false },
  { id: 'harassment_pamphlet', label: 'CA Sexual Harassment Pamphlet', required: false },
  { id: 'disability_pamphlet', label: 'CA EDD Disability Insurance Pamphlet', required: false },
  { id: 'family_leave_pamphlet', label: 'CA EDD Paid Family Leave Pamphlet', required: false },
  { id: 'domestic_violence_notice', label: 'Domestic Violence Leave Notice', required: false },
];

// ─── Uploadable Document Types (caregiver self-upload via link) ─
export const UPLOADABLE_DOCUMENT_TYPES = [
  { id: 'drivers_license', label: "Driver's License", required: true },
  { id: 'tb_test', label: 'TB Test Results', required: true },
  { id: 'cpr_cert', label: 'CPR Certification', required: false },
  { id: 'covid_vaccine', label: 'COVID Vaccine Card', required: false },
  { id: 'auto_insurance', label: 'Auto Insurance', required: false },
  { id: 'physical_exam', label: 'Physical Exam Results', required: false },
  { id: 'background_check', label: 'Background Check', required: false },
  { id: 'other', label: 'Other', required: false },
];

// ─── Employment Status (Active Roster) ──────────────────────
export const EMPLOYMENT_STATUSES = [
  { id: 'onboarding', label: 'Onboarding', color: '#6B7280', bg: '#F3F4F6' },
  { id: 'active', label: 'Active', color: '#15803D', bg: '#F0FDF4' },
  { id: 'on_leave', label: 'On Leave', color: '#A16207', bg: '#FFFBEB' },
  { id: 'inactive', label: 'Inactive', color: '#DC2626', bg: '#FEF2F2' },
  { id: 'terminated', label: 'Terminated', color: '#6B7280', bg: '#F3F4F6' },
];

// ─── Availability Types (Active Roster) ─────────────────────
export const AVAILABILITY_TYPES = [
  { id: 'full_time', label: 'Full-time' },
  { id: 'part_time', label: 'Part-time' },
  { id: 'weekends_only', label: 'Weekends Only' },
  { id: 'prn', label: 'PRN (As Needed)' },
];
