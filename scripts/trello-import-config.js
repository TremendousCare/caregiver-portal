// scripts/trello-import-config.js
// Configurable mappings for Trello import. Edit this file to change
// which lists are imported, how fields map, and what statuses are set.

/** Which Trello lists to import. Use exact list names from the board. */
const TARGET_LISTS = ['Deployed'];

/** Cards to skip by exact card title. */
const SKIP_CARDS = ['Chris Nash'];

/**
 * Per-list config: what employment_status and board_status to set.
 * Keys must match TARGET_LISTS entries exactly.
 */
const LIST_CONFIG = {
  'Deployed': {
    employment_status: 'active',
    board_status: 'deployed',
  },
  'Ready for Deployment': {
    employment_status: 'inactive',
    board_status: 'ready',
  },
  'Reserve Pool : Last Resort': {
    employment_status: 'inactive',
    board_status: 'reserve',
  },
  // Pipeline lists (for future rounds)
  'Phone Interview': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'intake',
  },
  'Virtual Interview': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'interview',
  },
  'Offer Out': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'interview',
  },
  'Onboarding': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'onboarding',
  },
  'I-9 Verification': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'verification',
  },
  'Orientation': {
    employment_status: 'onboarding',
    board_status: '',
    phase_override: 'orientation',
  },
};

/**
 * Trello checklist item name -> portal task ID.
 * If a Trello item isn't listed here, it's logged as unmapped.
 */
const CHECKLIST_TASK_MAP = {
  // Onboarding checklist
  'HCA Registered': 'hca_linked',
  'IRS Form I9': 'i9_form',
  'IRS Form W4': 'w4_form',
  'Employee Handbook Acknowledgement': 'employee_handbook',
  'Wage and Employment Notice': 'wage_notice',
  'Employee Agreement': 'employment_agreement',
  'Employee Emergency Contact': 'emergency_contact',
  'Direct Deposit Authorization': 'direct_deposit',
  'TB Test': 'tb_test',
  'Copy of Driver\'s License': 'docs_uploaded',
  'Training': 'training_assigned',
  // Orientation checklist
  'IRS Form I9 Identification Validation': 'i9_validation',
  'Questionnaire': 'questionnaire_done',
  'Scrub Top Size': 'scrubs_distributed',
};

/**
 * Trello checklist items that have no portal equivalent.
 * These are noted in the import note instead of mapped.
 */
const UNMAPPED_CHECKLIST_ITEMS = [
  'Copy of Automobile Insurance',
  'Social Media Check',
  'Social Media',
  'Social Media/Internet Search',
  'Bing/Google Search',
  'Complete Onboarding',
  'Scrub Top Size: M',
];

module.exports = {
  TARGET_LISTS,
  SKIP_CARDS,
  LIST_CONFIG,
  CHECKLIST_TASK_MAP,
  UNMAPPED_CHECKLIST_ITEMS,
};
