// ─── Client Pipeline Phases ─────────────────────────────────
export const CLIENT_PHASES = [
  {
    id: 'new_lead',
    label: 'New Lead',
    short: 'New Lead',
    icon: '\uD83D\uDD14',
    color: '#D97706',
    description: 'Lead just came in \u2014 immediate outreach required',
  },
  {
    id: 'initial_contact',
    label: 'Initial Contact',
    short: 'Contact',
    icon: '\uD83D\uDCDE',
    color: '#2E4E8D',
    description: 'First outreach made, awaiting response',
  },
  {
    id: 'consultation',
    label: 'Consultation',
    short: 'Consult',
    icon: '\uD83D\uDCAC',
    color: '#29BEE4',
    description: 'Initial call completed, care needs assessed',
  },
  {
    id: 'assessment',
    label: 'In-Home Assessment',
    short: 'Assessment',
    icon: '\uD83C\uDFE0',
    color: '#1084C3',
    description: 'Home visit scheduled or completed',
  },
  {
    id: 'proposal',
    label: 'Proposal',
    short: 'Proposal',
    icon: '\uD83D\uDCCB',
    color: '#3A6BA8',
    description: 'Care plan and pricing shared',
  },
  {
    id: 'won',
    label: 'Won',
    short: 'Won',
    icon: '\u2705',
    color: '#16A34A',
    description: 'Converted to active client \u2014 begin onboarding',
  },
  {
    id: 'lost',
    label: 'Lost',
    short: 'Lost',
    icon: '\u274C',
    color: '#DC3545',
    description: 'Did not convert',
  },
  {
    id: 'nurture',
    label: 'Nurture',
    short: 'Nurture',
    icon: '\uD83C\uDF31',
    color: '#8B5CF6',
    description: 'Not ready now \u2014 scheduled follow-up',
  },
];

// ─── Default Client Tasks ───────────────────────────────────
export const DEFAULT_CLIENT_TASKS = {
  new_lead: [
    { id: 'lead_reviewed', label: 'Lead reviewed and source verified' },
    { id: 'source_logged', label: 'Referral source and details logged' },
    { id: 'initial_call_attempted', label: 'Initial call attempted within 1 hour', critical: true },
    { id: 'voicemail_left', label: 'Voicemail left if no answer' },
    { id: 'intro_text_sent', label: 'Introductory text/email sent' },
  ],
  initial_contact: [
    { id: 'contact_made', label: 'Live contact established with decision-maker', critical: true },
    { id: 'needs_identified', label: 'Basic care needs identified (hours, type, urgency)' },
    { id: 'consultation_scheduled', label: 'Consultation call or visit scheduled', critical: true },
    { id: 'info_packet_sent', label: 'Information packet / brochure sent' },
  ],
  consultation: [
    { id: 'consultation_completed', label: 'Consultation call/meeting completed', critical: true },
    { id: 'care_needs_detailed', label: 'Detailed care needs documented (ADLs, medical, cognitive)' },
    { id: 'hours_confirmed', label: 'Hours and schedule preferences confirmed' },
    { id: 'budget_discussed', label: 'Budget and payment options discussed' },
    { id: 'assessment_scheduled', label: 'In-home assessment scheduled' },
  ],
  assessment: [
    { id: 'assessment_completed', label: 'In-home assessment visit completed', critical: true },
    { id: 'home_environment_noted', label: 'Home environment and safety notes documented' },
    { id: 'care_plan_drafted', label: 'Personalized care plan drafted', critical: true },
    { id: 'caregiver_requirements', label: 'Caregiver requirements defined (skills, personality, schedule)' },
  ],
  proposal: [
    { id: 'proposal_sent', label: 'Care plan and pricing proposal sent', critical: true },
    { id: 'proposal_followup', label: 'Follow-up call after proposal (within 48 hours)' },
    { id: 'questions_addressed', label: 'Questions and concerns addressed' },
    { id: 'agreement_sent', label: 'Service agreement sent for signature' },
  ],
  won: [
    { id: 'agreement_signed', label: 'Service agreement signed', critical: true },
    { id: 'caregiver_matched', label: 'Caregiver matched to client', critical: true },
    { id: 'start_date_confirmed', label: 'Start date and schedule confirmed' },
    { id: 'client_introduction', label: 'Client/family introduced to assigned caregiver' },
    { id: 'first_shift_confirmed', label: 'First shift completed and feedback collected', critical: true },
  ],
  lost: [
    { id: 'reason_logged', label: 'Reason for loss documented', critical: true },
    { id: 'feedback_collected', label: 'Feedback collected from family (if possible)' },
  ],
  nurture: [
    { id: 'nurture_reason_logged', label: 'Reason for nurture status documented' },
    { id: 'follow_up_date_set', label: 'Follow-up date set in calendar' },
  ],
};

// ─── Chase Scripts ──────────────────────────────────────────
export const CLIENT_CHASE_SCRIPTS = {
  new_lead: {
    title: 'Speed to Lead Protocol',
    scripts: [
      { day: 'Minute 0-15', action: 'Call + Text', script: 'Hi [ContactName], this is [YourName] with Tremendous Care. We received your inquiry about home care services and I\'d love to help. I\'m available now to discuss your family\'s needs \u2014 please call me back at (949) 226-7908.' },
      { day: 'Hour 1', action: 'Follow-up Text', script: 'Hi [ContactName], just following up \u2014 I know finding the right care can feel urgent. I\'m here to help whenever you\'re ready. Feel free to call or text me back.' },
      { day: 'Day 1 (PM)', action: 'Email + VM', script: 'I wanted to reach out once more today. We specialize in matching families with compassionate, experienced caregivers. I\'d love to learn more about your situation and see how we can help.' },
      { day: 'Day 2', action: 'Call + Text', script: 'Hi [ContactName], checking in again from Tremendous Care. Families often have questions about costs, caregiver qualifications, and scheduling \u2014 happy to walk through everything whenever you have a few minutes.' },
      { day: 'Day 4', action: 'Final Attempt', script: 'This is my last follow-up for now. If your situation changes or you\'d like to explore care options, please don\'t hesitate to reach out. We\'re always here to help.' },
    ],
  },
  initial_contact: {
    title: 'Consultation Booking Script',
    scripts: [
      { day: 'After contact', action: 'Schedule', script: 'Thank you for taking the time to speak with me. Based on what you\'ve shared, I think a consultation call would be the best next step so we can really understand [CareRecipientName]\'s needs. I have availability [Day/Time] \u2014 would that work for you?' },
      { day: 'Day 1 after schedule', action: 'Confirmation', script: 'Just confirming our consultation scheduled for [Date/Time]. If you have any questions beforehand, feel free to text or call me. Looking forward to speaking with you.' },
    ],
  },
  consultation: {
    title: 'Assessment Scheduling Script',
    scripts: [
      { day: 'End of consult', action: 'Schedule Assessment', script: 'Based on everything we discussed, I\'d love to schedule a brief in-home visit so we can see [CareRecipientName]\'s living environment and create a truly personalized care plan. It usually takes about 30-45 minutes. What day works best for you?' },
      { day: 'Day 1 post-consult', action: 'Follow-up Text', script: 'Great speaking with you yesterday. I\'m putting together some initial thoughts on a care plan. Would [Day] work for the in-home assessment?' },
      { day: 'Day 3 post-consult', action: 'Call + Text', script: 'Hi [ContactName], following up on our consultation. I want to make sure we move forward while the details are fresh. Can we get that home visit on the calendar?' },
    ],
  },
  assessment: {
    title: 'Post-Assessment Follow-Up',
    scripts: [
      { day: 'Same day', action: 'Thank you text', script: 'Thank you for welcoming me into your home today. I have a much better picture of [CareRecipientName]\'s needs now. I\'ll have a personalized care plan and pricing proposal to you within 24-48 hours.' },
      { day: 'Day 1-2', action: 'Send proposal', script: 'Attached is the care plan we discussed, tailored specifically for [CareRecipientName]. I\'ve included pricing for the schedule we talked about. Happy to walk through it together \u2014 when works best for a quick call?' },
    ],
  },
  proposal: {
    title: 'Proposal Follow-Up & Close',
    scripts: [
      { day: 'Day 1', action: 'Follow-up Call', script: 'Hi [ContactName], I wanted to check in and see if you had a chance to review the care plan. Do you have any questions about the services or pricing? I\'m happy to adjust anything to better fit your needs.' },
      { day: 'Day 3', action: 'Value Add Text', script: 'Just a quick note \u2014 I wanted to let you know that we have an excellent caregiver who would be a great match for [CareRecipientName]. She has [X years] experience and specializes in [relevant skill]. Would you like to learn more?' },
      { day: 'Day 5', action: 'Urgency Call', script: 'I wanted to follow up one more time. I know this is a big decision, and I\'m here to help however I can. If timing or pricing is a concern, let\'s talk \u2014 we may be able to work something out.' },
      { day: 'Day 7', action: 'Soft Close', script: 'Hi [ContactName], I don\'t want to be pushy, but I also don\'t want you to miss out on the caregiver I mentioned. If you\'re ready to move forward, I can have her start as early as [Date]. Just let me know.' },
    ],
  },
};

// ─── Client Sources ─────────────────────────────────────────
export const CLIENT_SOURCES = [
  'Website Form',
  'Phone Call',
  'Referral - Current Client',
  'Referral - Professional',
  'Doctor/Hospital',
  'Insurance Company',
  'Social Worker',
  'Google Search',
  'Facebook',
  'Yelp',
  'Home Advisor',
  'Word of Mouth',
  'Event',
  'Other',
];

// ─── Client Priorities ──────────────────────────────────────
export const CLIENT_PRIORITIES = [
  { id: 'urgent', label: 'Urgent', color: '#DC3545' },
  { id: 'high', label: 'High', color: '#D97706' },
  { id: 'normal', label: 'Normal', color: '#2E4E8D' },
  { id: 'low', label: 'Low', color: '#7A8BA0' },
];

// ─── Lost Reasons ───────────────────────────────────────────
export const LOST_REASONS = [
  'Price too high',
  'Chose competitor',
  'No longer needs care',
  'Timing not right',
  'Unresponsive',
  'Location not serviceable',
  'Insurance issue',
  'Other',
];
