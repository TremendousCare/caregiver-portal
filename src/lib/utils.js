import { PHASES } from './constants';
import { getPhaseTasks } from './storage';

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
  if (caregiver.phaseOverride) return caregiver.phaseOverride;
  return getCalculatedPhase(caregiver);
};

export const getOverallProgress = (caregiver) => {
  const allTasks = Object.values(getPhaseTasks()).flat();
  if (allTasks.length === 0) return 0;
  const done = allTasks.filter((t) => isTaskDone(caregiver.tasks?.[t.id])).length;
  return Math.round((done / allTasks.length) * 100);
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

// ─── Green Light ─────────────────────────────────────────────

export const isGreenLight = (caregiver) => {
  const required = ['offer_signed', 'i9_form', 'w4_form', 'hca_cleared', 'tb_test', 'training_assigned'];
  return required.every((t) => isTaskDone(caregiver.tasks?.[t]));
};

// ─── Formatting ──────────────────────────────────────────────

export const formatDate = (ts) => {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
