import { CLIENT_PHASES } from './constants';
import { getClientPhaseTasks } from './storage';

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

// Care Plan and Service Plans are clinical/operational artifacts that
// only become relevant once we're actively closing the deal. Showing
// them for early-funnel leads (new_lead → assessment) just adds empty
// state noise. They appear together at proposal and stay through won.
// Lost/nurture are terminal — hide there too.
const PLAN_VISIBLE_PHASES = new Set(['proposal', 'won']);

export const shouldShowClientPlanPanels = (client) => {
  return PLAN_VISIBLE_PHASES.has(getClientPhase(client));
};

// ─── Phase Progress ─────────────────────────────────────────

export const getClientPhaseProgress = (client, phaseId) => {
  const tasks = getClientPhaseTasks()[phaseId];
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
    const tasks = getClientPhaseTasks()[phaseId];
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

// isClientOverdue() removed — card-level "overdue" status is now
// derived from the configurable action item rules engine, so the
// Settings toggles are the single source of truth. See
// generateClientActionItems() and the dashboard's overdueIds set.

// Per-phase SLA windows in milliseconds — how long a client can sit in
// a phase before a top-of-profile overdue banner shows up. New Lead is
// the strictest (1h Speed-to-Lead rule); the other active phases get
// a few days of grace. Terminal phases (won/lost/nurture) never go
// overdue.
//
// Keys cover both the pre- and post-consolidation phase sets so this
// helper keeps working through and after the phase migration PR.
const PHASE_SLA_MS = {
  new_lead: 1 * 60 * 60 * 1000,             // 1 hour
  initial_contact: 2 * 24 * 60 * 60 * 1000, // 2 days (legacy)
  consultation: 3 * 24 * 60 * 60 * 1000,    // 3 days (legacy)
  assessment: 7 * 24 * 60 * 60 * 1000,      // 7 days (legacy)
  consult: 3 * 24 * 60 * 60 * 1000,         // 3 days (consolidated)
  proposal: 5 * 24 * 60 * 60 * 1000,        // 5 days
};

function phaseEntryTime(client, phase) {
  if (phase === 'new_lead') {
    if (!client.createdAt) return null;
    return typeof client.createdAt === 'number'
      ? client.createdAt
      : new Date(client.createdAt).getTime();
  }
  const ts = client.phaseTimestamps?.[phase];
  if (!ts) return null;
  return typeof ts === 'number' ? ts : new Date(ts).getTime();
}

export const getClientOverdueStatus = (client, now = Date.now()) => {
  const phase = getClientPhase(client);
  if (['won', 'lost', 'nurture'].includes(phase)) return null;
  const sla = PHASE_SLA_MS[phase];
  if (!sla) return null;
  const entryTime = phaseEntryTime(client, phase);
  if (!entryTime) return null;
  const elapsed = now - entryTime;
  if (elapsed <= sla) return null;
  return {
    phase,
    elapsedMs: elapsed,
    overdueMs: elapsed - sla,
    slaMs: sla,
  };
};

// ─── Next Step ──────────────────────────────────────────────

export const getNextStep = (client) => {
  const phase = getClientPhase(client);
  const tasks = getClientPhaseTasks()[phase];
  if (!tasks) return null;

  // Find the first incomplete task in current phase
  for (const task of tasks) {
    if (!isTaskDone(client.tasks?.[task.id])) {
      return {
        taskId: task.id,
        label: task.label,
        critical: !!task.critical,
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
    };
  }

  return null;
};

// ─── Formatting ─────────────────────────────────────────────

export const formatDate = (ts) => {
  if (!ts) return '\u2014';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
