import { CLIENT_PHASES, DEFAULT_CLIENT_TASKS } from './constants';

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

// ─── Phase Helpers ──────────────────────────────────────────
// Clients use explicit phase (not calculated from tasks like caregivers).

export const getClientPhase = (client) => {
  return client.phase || 'new_lead';
};

// ─── Phase Progress ─────────────────────────────────────────

export const getClientPhaseProgress = (client, phaseId) => {
  const tasks = DEFAULT_CLIENT_TASKS[phaseId];
  if (!tasks || tasks.length === 0) return { done: 0, total: 0, pct: 0 };
  const done = tasks.filter((t) => isTaskDone(client.tasks?.[t.id])).length;
  return { done, total: tasks.length, pct: Math.round((done / tasks.length) * 100) };
};

export const getClientOverallProgress = (client) => {
  // Exclude lost and nurture phases from the denominator
  const activePhaseIds = CLIENT_PHASES
    .filter((p) => p.id !== 'lost' && p.id !== 'nurture')
    .map((p) => p.id);

  let totalTasks = 0;
  let doneTasks = 0;

  for (const phaseId of activePhaseIds) {
    const tasks = DEFAULT_CLIENT_TASKS[phaseId];
    if (!tasks) continue;
    totalTasks += tasks.length;
    doneTasks += tasks.filter((t) => isTaskDone(client.tasks?.[t.id])).length;
  }

  if (totalTasks === 0) return 0;
  return Math.round((doneTasks / totalTasks) * 100);
};

// ─── Days Calculations ──────────────────────────────────────

export const getDaysInClientPhase = (client) => {
  const phase = getClientPhase(client);
  const phaseStart = client.phaseTimestamps?.[phase];
  if (!phaseStart) return 0;
  return Math.floor((Date.now() - phaseStart) / 86400000);
};

export const getDaysSinceCreated = (client) => {
  if (!client.createdAt) return 0;
  const created = typeof client.createdAt === 'number'
    ? client.createdAt
    : new Date(client.createdAt).getTime();
  return Math.floor((Date.now() - created) / 86400000);
};

// ─── Overdue Detection ──────────────────────────────────────

export const isClientOverdue = (client) => {
  const phase = getClientPhase(client);
  const tasks = DEFAULT_CLIENT_TASKS[phase];
  if (!tasks) return false;

  const hasCriticalIncomplete = tasks.some(
    (t) => t.critical && !isTaskDone(client.tasks?.[t.id])
  );
  if (!hasCriticalIncomplete) return false;

  // For new_lead, threshold is 1 hour based on createdAt
  if (phase === 'new_lead') {
    const created = client.createdAt
      ? (typeof client.createdAt === 'number' ? client.createdAt : new Date(client.createdAt).getTime())
      : null;
    if (!created) return false;
    const hoursSinceCreated = (Date.now() - created) / 3600000;
    return hoursSinceCreated > 1;
  }

  // For all other phases, threshold is 2 days in phase
  const daysInPhase = getDaysInClientPhase(client);
  return daysInPhase > 2;
};

// ─── Next Step ──────────────────────────────────────────────

export const getNextStep = (client) => {
  const phase = getClientPhase(client);
  const tasks = DEFAULT_CLIENT_TASKS[phase];
  if (!tasks) return null;

  // Find the first incomplete task in current phase
  for (const task of tasks) {
    if (!isTaskDone(client.tasks?.[task.id])) {
      // Determine if this specific task is overdue
      let overdue = false;
      if (task.critical) {
        if (phase === 'new_lead') {
          const created = client.createdAt
            ? (typeof client.createdAt === 'number' ? client.createdAt : new Date(client.createdAt).getTime())
            : null;
          if (created) {
            overdue = (Date.now() - created) / 3600000 > 1;
          }
        } else {
          overdue = getDaysInClientPhase(client) > 2;
        }
      }

      return {
        taskId: task.id,
        label: task.label,
        critical: !!task.critical,
        overdue,
      };
    }
  }

  // All tasks in current phase are done — suggest advancing
  const currentIndex = CLIENT_PHASES.findIndex((p) => p.id === phase);
  const nextPhase = CLIENT_PHASES[currentIndex + 1];
  if (nextPhase && nextPhase.id !== 'lost' && nextPhase.id !== 'nurture') {
    return {
      taskId: null,
      label: `All ${phase} tasks complete \u2014 ready to advance to ${nextPhase.label}`,
      critical: false,
      overdue: false,
    };
  }

  return null;
};

// ─── Formatting ─────────────────────────────────────────────

export const formatDate = (ts) => {
  if (!ts) return '\u2014';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
