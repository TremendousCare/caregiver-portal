// ═══════════════════════════════════════════════════════════════
// Survey Utilities & Qualification Engine
//
// Pure functions for working with caregiver pre-screening surveys.
// No side effects, no DB calls — all logic is testable.
// ═══════════════════════════════════════════════════════════════

/**
 * Question types supported by the survey builder.
 */
export const QUESTION_TYPES = [
  { value: 'yes_no', label: 'Yes / No' },
  { value: 'multiple_choice', label: 'Multiple Choice' },
  { value: 'multi_select', label: 'Multiple Select (checkboxes)' },
  { value: 'free_text', label: 'Free Text' },
  { value: 'number', label: 'Number' },
  { value: 'availability_schedule', label: 'Weekly Availability' },
];

/**
 * Question types whose answers are treated as structured data and do
 * NOT participate in profile_field mapping or qualification rules.
 */
export const STRUCTURED_QUESTION_TYPES = ['availability_schedule'];

export function isStructuredQuestion(type) {
  return STRUCTURED_QUESTION_TYPES.includes(type);
}

/**
 * Qualification actions that can be assigned to answers.
 */
export const QUALIFICATION_ACTIONS = [
  { value: 'pass', label: 'Pass', color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
  { value: 'flag', label: 'Flag for Review', color: '#A16207', bg: '#FFFBEB', border: '#FDE68A' },
  { value: 'disqualify', label: 'Disqualify', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
];

/**
 * Generate a short unique ID for questions.
 */
export function generateQuestionId() {
  return 'q_' + crypto.randomUUID().slice(0, 8);
}

/**
 * Generate a unique survey token for a caregiver response.
 */
export function generateSurveyToken() {
  return 'sv_' + crypto.randomUUID().replace(/-/g, '');
}

/**
 * Create a blank question object with defaults.
 */
export function createBlankQuestion() {
  return {
    id: generateQuestionId(),
    text: '',
    type: 'yes_no',
    required: true,
    options: ['Yes', 'No'],
    qualification_rules: [],
  };
}

/**
 * Caregiver profile fields that survey answers can be mapped to.
 */
export const PROFILE_FIELD_OPTIONS = [
  { value: '', label: 'None (don\'t map)' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'address', label: 'Address' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'zip', label: 'Zip Code' },
  { value: 'per_id', label: 'HCA PER ID #' },
  { value: 'has_hca', label: 'HCA Status' },
  { value: 'has_dl', label: 'Driver\'s License' },
  { value: 'has_vehicle', label: 'Has Vehicle' },
  { value: 'tb_test', label: 'TB Test' },
  { value: 'auto_insurance', label: 'Auto Insurance' },
  { value: 'allergies', label: 'Allergies' },
  { value: 'client_gender_preference', label: 'Client Gender Preference' },
  { value: 'years_experience', label: 'Years of Experience' },
  { value: 'availability', label: 'Availability' },
  { value: 'preferred_shift', label: 'Preferred Shift' },
  { value: 'languages', label: 'Languages' },
  { value: 'specializations', label: 'Specializations' },
  { value: 'certifications', label: 'Certifications' },
  { value: 'proposed_pay_rate', label: 'Proposed Pay Rate' },
];

// Profile fields that the Interview Evaluation form is allowed to write
// back to. Kept separate from PROFILE_FIELD_OPTIONS so the UI dropdown
// for general surveys stays broad while internal form writes are
// explicit and reviewable.
export const INTERVIEW_WRITEBACK_FIELDS = new Set([
  'phone', 'email', 'city',
  'per_id', 'has_hca', 'has_dl', 'has_vehicle',
  'tb_test', 'auto_insurance',
  'allergies', 'client_gender_preference',
  'years_experience', 'availability',
  'proposed_pay_rate',
]);

// Reverse map: snake_case profile field -> camelCase property on the
// caregiver app model. Used to pre-fill the evaluation form from
// existing caregiver data.
const PROFILE_FIELD_TO_CAREGIVER_KEY = {
  phone: 'phone',
  email: 'email',
  address: 'address',
  city: 'city',
  state: 'state',
  zip: 'zip',
  per_id: 'perId',
  has_hca: 'hasHCA',
  has_dl: 'hasDL',
  has_vehicle: 'hasVehicle',
  tb_test: 'tbTest',
  auto_insurance: 'autoInsurance',
  allergies: 'allergies',
  client_gender_preference: 'clientGenderPreference',
  years_experience: 'yearsExperience',
  availability: 'availability',
  preferred_shift: 'preferredShift',
  languages: 'languages',
  specializations: 'specializations',
  certifications: 'certifications',
  proposed_pay_rate: 'proposedPayRate',
};

/**
 * Build an initial answers map by pulling existing caregiver values
 * into questions whose `profile_field` points to a known caregiver
 * property. Returns `{}` if no fields can be pre-filled.
 *
 * Value normalization:
 *   - yes_no / multiple_choice: title-case "yes" -> "Yes" so the
 *     renderer highlights the matching option pill.
 *   - multi_select: if stored value is a comma-separated string,
 *     split it into an array matched against `options`.
 */
export function prefillAnswersFromCaregiver(questions, caregiver) {
  if (!Array.isArray(questions) || !caregiver) return {};
  const answers = {};
  for (const q of questions) {
    if (!q || !q.profile_field) continue;
    const key = PROFILE_FIELD_TO_CAREGIVER_KEY[q.profile_field];
    if (!key) continue;
    const raw = caregiver[key];
    if (raw === undefined || raw === null || raw === '') continue;

    if (q.type === 'yes_no' || q.type === 'multiple_choice') {
      const strVal = String(raw);
      const options = Array.isArray(q.options) ? q.options : [];
      const match = options.find((o) => String(o).trim().toLowerCase() === strVal.trim().toLowerCase());
      if (match) answers[q.id] = match;
      else answers[q.id] = strVal;
    } else if (q.type === 'multi_select') {
      let arr = [];
      if (Array.isArray(raw)) arr = raw;
      else if (typeof raw === 'string') arr = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (Array.isArray(q.options) && q.options.length > 0) {
        const lower = new Map(q.options.map((o) => [String(o).toLowerCase(), o]));
        arr = arr.map((v) => lower.get(String(v).toLowerCase()) || v);
      }
      if (arr.length > 0) answers[q.id] = arr;
    } else if (q.type === 'number') {
      const num = Number(raw);
      if (Number.isFinite(num)) answers[q.id] = num;
    } else {
      answers[q.id] = String(raw);
    }
  }
  return answers;
}

/**
 * Get the default options for a question type.
 */
export function getDefaultOptions(type) {
  switch (type) {
    case 'yes_no': return ['Yes', 'No'];
    case 'multiple_choice': return ['Option 1', 'Option 2'];
    case 'multi_select': return ['Option 1', 'Option 2'];
    case 'free_text': return [];
    case 'number': return [];
    case 'availability_schedule': return [];
    default: return [];
  }
}

/**
 * Check whether a question type supports predefined answer options.
 */
export function hasOptions(type) {
  return type === 'yes_no' || type === 'multiple_choice' || type === 'multi_select';
}

// ═══════════════════════════════════════════════════════════════
// Qualification Engine
// ═══════════════════════════════════════════════════════════════

/**
 * Evaluate a caregiver's survey answers against qualification rules.
 *
 * @param {Array} questions - The survey template's question array
 * @param {Object} answers - Map of question_id → answer value
 * @returns {{ status: 'qualified'|'flagged'|'disqualified', results: Array }}
 *
 * Logic:
 * - If ANY answer triggers a 'disqualify' rule → status = 'disqualified'
 * - If ANY answer triggers a 'flag' rule → status = 'flagged'
 * - Otherwise → status = 'qualified'
 */
export function evaluateSurveyAnswers(questions, answers) {
  const results = [];

  for (const question of questions) {
    if (isStructuredQuestion(question.type)) continue;
    const answer = answers[question.id];
    if (answer === undefined || answer === null || answer === '') continue;

    const rules = question.qualification_rules || [];
    for (const rule of rules) {
      if (matchesRule(answer, rule.answer, question.type)) {
        results.push({
          question_id: question.id,
          question_text: question.text,
          answer,
          action: rule.action,
          reason: rule.reason || '',
        });
      }
    }
  }

  // Determine overall status: disqualify > flag > qualified
  let status = 'qualified';
  if (results.some((r) => r.action === 'flag')) status = 'flagged';
  if (results.some((r) => r.action === 'disqualify')) status = 'disqualified';

  return { status, results };
}

/**
 * Check if a given answer matches a rule's answer pattern.
 * Supports exact match and case-insensitive comparison.
 */
function matchesRule(answer, ruleAnswer, questionType) {
  if (!ruleAnswer && ruleAnswer !== 0) return false;

  if (questionType === 'number') {
    return matchesNumberRule(answer, ruleAnswer);
  }

  // For multi_select, check if the rule's answer is in the selected array
  if (questionType === 'multi_select' && Array.isArray(answer)) {
    const ruleStr = String(ruleAnswer).trim().toLowerCase();
    return answer.some((a) => String(a).trim().toLowerCase() === ruleStr);
  }

  const answerStr = String(answer).trim().toLowerCase();
  const ruleStr = String(ruleAnswer).trim().toLowerCase();
  return answerStr === ruleStr;
}

/**
 * Match a numeric answer against a rule that may include comparison operators.
 * Supports: "< 5", "> 10", "<= 3", ">= 5", "= 3", or plain "3" (exact match).
 */
export function matchesNumberRule(answer, ruleAnswer) {
  const num = parseFloat(answer);
  if (isNaN(num)) return false;

  const ruleStr = String(ruleAnswer).trim();

  // Try to parse operator + number
  const match = ruleStr.match(/^([<>=!]+)\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    const op = match[1];
    const target = parseFloat(match[2]);
    switch (op) {
      case '<':  return num < target;
      case '<=': return num <= target;
      case '>':  return num > target;
      case '>=': return num >= target;
      case '=':  return num === target;
      case '!=': return num !== target;
      default:   return false;
    }
  }

  // Plain number — exact match
  const target = parseFloat(ruleStr);
  return !isNaN(target) && num === target;
}

/**
 * Validate that all required questions have been answered.
 *
 * @param {Array} questions - The survey template's question array
 * @param {Object} answers - Map of question_id → answer value
 * @returns {Array} Array of question IDs that are missing required answers
 */
export function validateRequiredAnswers(questions, answers) {
  const missing = [];
  for (const q of questions) {
    if (!q.required) continue;
    const answer = answers[q.id];
    if (answer === undefined || answer === null) {
      missing.push(q.id);
    } else if (q.type === 'availability_schedule') {
      // Structured answer — require at least one slot
      const slots = Array.isArray(answer?.slots) ? answer.slots : [];
      if (slots.length === 0) missing.push(q.id);
    } else if (Array.isArray(answer)) {
      if (answer.length === 0) missing.push(q.id);
    } else if (String(answer).trim() === '') {
      missing.push(q.id);
    }
  }
  return missing;
}

/**
 * Get a human-readable summary of qualification results.
 */
export function getQualificationSummary(results) {
  const disqualified = results.filter((r) => r.action === 'disqualify');
  const flagged = results.filter((r) => r.action === 'flag');

  const parts = [];
  if (disqualified.length > 0) {
    parts.push(`Disqualified: ${disqualified.map((r) => r.reason || r.question_text).join('; ')}`);
  }
  if (flagged.length > 0) {
    parts.push(`Flagged: ${flagged.map((r) => r.reason || r.question_text).join('; ')}`);
  }
  if (parts.length === 0) {
    return 'All answers passed qualification checks.';
  }
  return parts.join(' | ');
}

/**
 * Extract profile field updates from survey answers based on field mappings.
 *
 * @param {Array} questions - The survey template's question array
 * @param {Object} answers - Map of question_id → answer value
 * @returns {Object} Map of profile field → value to update
 */
// Fields that store lowercase 'yes'/'no' values in the caregiver record
const LOWERCASE_YES_NO_FIELDS = ['has_hca', 'has_dl', 'has_vehicle'];

export function extractProfileFieldUpdates(questions, answers) {
  const updates = {};
  for (const q of questions) {
    if (!q.profile_field) continue;
    // Structured answers (e.g. availability_schedule) are synced via
    // dedicated action types, not through scalar profile_field mapping.
    if (isStructuredQuestion(q.type)) continue;
    const answer = answers[q.id];
    if (answer === undefined || answer === null) continue;

    // For multi-select, join array into comma-separated string
    if (Array.isArray(answer)) {
      if (answer.length > 0) updates[q.profile_field] = answer.join(', ');
    } else if (String(answer).trim() !== '') {
      let value = String(answer).trim();
      // Normalize "Yes"/"No" to lowercase for fields that expect it
      if (LOWERCASE_YES_NO_FIELDS.includes(q.profile_field)) {
        const lower = value.toLowerCase();
        if (lower === 'yes' || lower === 'no') value = lower;
      }
      updates[q.profile_field] = value;
    }
  }
  return updates;
}

const SURVEY_BASE_URL = 'https://portal.tremendouscareca.com';

/**
 * Build the survey URL for a given token.
 * Always uses the custom domain so SMS links pass carrier content filtering.
 */
export function buildSurveyUrl(token) {
  return `${SURVEY_BASE_URL}/survey/${token}`;
}
