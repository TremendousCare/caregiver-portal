import { PHASES, SUB_PHASES } from './constants';
import { getPhaseTasks } from './storage';
import { normalizePhone } from './intakeProcessing';

// ─── Sub-Phase Helpers ───────────────────────────────────────
// Sub-phases (e.g. 'intake_pending', 'interview_pending_hca') are wait
// states within a parent main phase. When phase_override is a sub-phase
// id, the caregiver is treated as being in the parent phase, but the
// sub-phase filters/predicates also match. See SUB_PHASES in constants.

export const getSubPhase = (overrideId) =>
  SUB_PHASES.find((s) => s.id === overrideId) || null;

// ─── Task Value Helpers ─────────────────────────────────────
// Tasks can be stored as:
//   - boolean true/false (legacy format)
//   - { completed: true, completedAt: timestamp } (new enriched format)
// This helper normalizes both formats.

export const isTaskDone = (taskValue) => {
  if (typeof taskValue === 'boolean') return taskValue;
  if (typeof taskValue === 'object' && taskValue !== null) return !!taskValue.completed;
  return false;
};

// ─── Phase Progress ──────────────────────────────────────────

export const getPhaseProgress = (caregiver, phaseId) => {
  const tasks = getPhaseTasks()[phaseId];
  if (!tasks || tasks.length === 0) return { done: 0, total: 0, pct: 0 };
  const done = tasks.filter((t) => isTaskDone(caregiver.tasks?.[t.id])).length;
  return { done, total: tasks.length, pct: Math.round((done / tasks.length) * 100) };
};

export const getCalculatedPhase = (caregiver) => {
  for (const phase of PHASES) {
    const { pct } = getPhaseProgress(caregiver, phase.id);
    if (pct < 100) return phase.id;
  }
  return 'orientation';
};

export const getCurrentPhase = (caregiver) => {
  if (caregiver.phaseOverride) {
    const sub = getSubPhase(caregiver.phaseOverride);
    return sub ? sub.parent : caregiver.phaseOverride;
  }
  return getCalculatedPhase(caregiver);
};

export const getOverallProgress = (caregiver) => {
  const allTasks = Object.values(getPhaseTasks()).flat();
  if (allTasks.length === 0) return 0;
  const done = allTasks.filter((t) => isTaskDone(caregiver.tasks?.[t.id])).length;
  return Math.round((done / allTasks.length) * 100);
};

// ─── Pending Interview (link sent, awaiting response) ──────
// The intake checklist is agency-customizable, so match by label
// keywords rather than hard-coded IDs. Returns null when no matching
// task exists — the feature degrades silently instead of throwing.

const findIntakeTaskId = (predicate) => {
  const tasks = getPhaseTasks()?.intake;
  if (!Array.isArray(tasks)) return null;
  const match = tasks.find((t) => predicate((t.label || '').toLowerCase()));
  return match?.id || null;
};

const findInterviewLinkSentTaskId = () =>
  findIntakeTaskId((l) => /\bsend\b/.test(l) && /\blink\b/.test(l) && /(interview|schedule)/.test(l));

const findInterviewScheduledTaskId = () =>
  findIntakeTaskId((l) => /(interview\s*scheduled|scheduled\s*interview|interview\s*booked|book(ed)?\s*interview)/.test(l));

export const getInterviewLinkSentAt = (caregiver) => {
  const id = findInterviewLinkSentTaskId();
  if (!id) return null;
  const task = caregiver?.tasks?.[id];
  if (!isTaskDone(task)) return null;
  const ts = typeof task === 'object' ? task?.completedAt : null;
  if (!ts) return null;
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  return Number.isFinite(t) ? t : null;
};

export const isAwaitingInterviewResponse = (caregiver) => {
  if (!caregiver) return false;
  // Manual sub-phase override is authoritative — operators use it to
  // put a caregiver back into "Pending Interview" after a mistaken
  // advance, regardless of task state.
  if (
    caregiver.phaseOverride === 'intake_pending' ||
    caregiver.phaseOverride === 'intake_pending_non_hca'
  ) return true;
  if (getCurrentPhase(caregiver) !== 'intake') return false;
  const linkId = findInterviewLinkSentTaskId();
  if (!linkId || !isTaskDone(caregiver.tasks?.[linkId])) return false;
  const scheduledId = findInterviewScheduledTaskId();
  if (scheduledId && isTaskDone(caregiver.tasks?.[scheduledId])) return false;
  return true;
};

// Pending-interview split by HCA registration. Sidebar/filter use these to
// route non-HCA applicants to a separate "Non-HCA" subtab while HCA-registered
// applicants stay in "Pending Interview". hasHCA is the editable Personal
// Information field, so flipping it to 'yes' immediately moves the caregiver
// into the HCA tab. A manual sub-phase override wins over hasHCA so operators
// can place someone in a specific bucket explicitly.
export const isAwaitingInterviewHca = (caregiver) => {
  if (caregiver?.phaseOverride === 'intake_pending') return true;
  if (caregiver?.phaseOverride === 'intake_pending_non_hca') return false;
  return isAwaitingInterviewResponse(caregiver) && caregiver?.hasHCA === 'yes';
};

export const isAwaitingInterviewNonHca = (caregiver) => {
  if (caregiver?.phaseOverride === 'intake_pending_non_hca') return true;
  if (caregiver?.phaseOverride === 'intake_pending') return false;
  return isAwaitingInterviewResponse(caregiver) && caregiver?.hasHCA !== 'yes';
};

export const getDaysSinceInterviewLinkSent = (caregiver) => {
  const ts = getInterviewLinkSentAt(caregiver);
  if (ts == null) return null;
  return Math.floor((Date.now() - ts) / 86400000);
};

// ─── Pending HCA (interview evaluation done, HCA not verified) ─
// Same label-matching strategy as the intake helpers above — the
// interview checklist is agency-customizable, so we match by keyword
// rather than hard-coded IDs.

const findInterviewTaskId = (predicate) => {
  const tasks = getPhaseTasks()?.interview;
  if (!Array.isArray(tasks)) return null;
  const match = tasks.find((t) => predicate((t.label || '').toLowerCase()));
  return match?.id || null;
};

const findInterviewEvaluationTaskId = () =>
  findInterviewTaskId((l) => /interview/.test(l) && /evaluation/.test(l));

const findVerifyHcaTaskId = () =>
  findInterviewTaskId((l) => /\bhca\b/.test(l) && /(verify|verified|verification|cleared|confirm)/.test(l));

export const getInterviewEvaluationCompletedAt = (caregiver) => {
  const id = findInterviewEvaluationTaskId();
  if (!id) return null;
  const task = caregiver?.tasks?.[id];
  if (!isTaskDone(task)) return null;
  const ts = typeof task === 'object' ? task?.completedAt : null;
  if (!ts) return null;
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  return Number.isFinite(t) ? t : null;
};

export const isAwaitingHcaVerification = (caregiver) => {
  if (!caregiver) return false;
  if (caregiver.phaseOverride === 'interview_pending_hca') return true;
  if (getCurrentPhase(caregiver) !== 'interview') return false;
  const evalId = findInterviewEvaluationTaskId();
  if (!evalId || !isTaskDone(caregiver.tasks?.[evalId])) return false;
  const hcaId = findVerifyHcaTaskId();
  if (hcaId && isTaskDone(caregiver.tasks?.[hcaId])) return false;
  return true;
};

export const getDaysSinceInterviewEvaluation = (caregiver) => {
  const ts = getInterviewEvaluationCompletedAt(caregiver);
  if (ts == null) return null;
  return Math.floor((Date.now() - ts) / 86400000);
};

// ─── Days Calculations ───────────────────────────────────────

export const getDaysInPhase = (caregiver) => {
  const phase = getCurrentPhase(caregiver);
  const phaseStart = caregiver.phaseTimestamps?.[phase];
  if (!phaseStart) return 0;
  return Math.floor((Date.now() - phaseStart) / 86400000);
};

export const getDaysSinceApplication = (caregiver) => {
  if (!caregiver.applicationDate) return 0;
  return Math.floor((Date.now() - new Date(caregiver.applicationDate).getTime()) / 86400000);
};

// ─── Dashboard Sort ──────────────────────────────────────────
//
// Survey responders float to the top so they can be reviewed first,
// then remaining applicants are ordered by application age (oldest
// first) to surface anyone who has been waiting the longest.
export const sortCaregiversForDashboard = (caregivers, surveyStatuses = {}) => {
  return [...caregivers].sort((a, b) => {
    const aHasSurvey = !!surveyStatuses[a.id];
    const bHasSurvey = !!surveyStatuses[b.id];
    if (aHasSurvey !== bHasSurvey) return aHasSurvey ? -1 : 1;
    return getDaysSinceApplication(b) - getDaysSinceApplication(a);
  });
};

// ─── Green Light ─────────────────────────────────────────────

export const isGreenLight = (caregiver) => {
  const required = ['offer_signed', 'i9_form', 'w4_form', 'hca_cleared', 'tb_test', 'training_assigned'];
  return required.every((t) => isTaskDone(caregiver.tasks?.[t]));
};

// ─── Duplicate Detection ─────────────────────────────────────

const normalizeName = (s) => (s || '').trim().toLowerCase();

// Returns the first non-archived caregiver whose first name, last
// name, and phone number all match the given input. Matching is
// case-insensitive on names and digit-only on phones (country-code
// "1" is stripped). Returns null when any identifier is missing or
// no match is found. Used to warn operators of likely duplicates
// before a new caregiver is saved.
export const findDuplicateCaregiver = ({ firstName, lastName, phone }, caregivers) => {
  const fn = normalizeName(firstName);
  const ln = normalizeName(lastName);
  const ph = normalizePhone(phone || '');
  if (!fn || !ln || !ph) return null;
  return caregivers.find((cg) =>
    !cg.archived &&
    normalizeName(cg.firstName) === fn &&
    normalizeName(cg.lastName) === ln &&
    normalizePhone(cg.phone || '') === ph
  ) || null;
};

// ─── Formatting ──────────────────────────────────────────────

export const formatDate = (ts) => {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
