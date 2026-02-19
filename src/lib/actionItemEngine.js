import { supabase, isSupabaseConfigured } from './supabase';
import { getCurrentPhase, getDaysInPhase, getDaysSinceApplication, isTaskDone } from './utils';
import { getClientPhase, getDaysInClientPhase, getDaysSinceCreated, isTaskDone as clientIsTaskDone } from '../features/clients/utils';

// ═══════════════════════════════════════════════════════════════
// Configurable Action Item Engine
//
// Evaluates rules from the action_item_rules table against
// caregiver/client data to produce prioritized action items.
// Falls back to hardcoded logic if rules haven't loaded yet.
// ═══════════════════════════════════════════════════════════════

const URGENCY_ORDER = { critical: 0, warning: 1, info: 2 };

// ─── Rules Cache ─────────────────────────────────────────────

let _rulesCache = null;
let _rulesLoading = false;

export function getActionItemRules() {
  return _rulesCache;
}

export async function loadActionItemRules() {
  if (!isSupabaseConfigured()) return null;
  if (_rulesLoading) return _rulesCache;

  _rulesLoading = true;
  try {
    const { data, error } = await supabase
      .from('action_item_rules')
      .select('*')
      .eq('enabled', true)
      .order('sort_order', { ascending: true });

    if (!error && data) {
      _rulesCache = data;
    }
  } catch (err) {
    console.warn('Failed to load action item rules:', err);
  } finally {
    _rulesLoading = false;
  }
  return _rulesCache;
}

export function clearActionItemRulesCache() {
  _rulesCache = null;
}

// ─── Entity Adapters ─────────────────────────────────────────

const caregiverAdapter = {
  entityType: 'caregiver',
  getId: (cg) => cg.id,
  getName: (cg) => `${cg.firstName || ''} ${cg.lastName || ''}`.trim() || 'Unnamed',
  getPhase: (cg) => getCurrentPhase(cg),
  getDaysInPhase: (cg) => getDaysInPhase(cg),
  getDaysSinceCreation: (cg) => getDaysSinceApplication(cg),
  getMinutesSinceCreation: (cg) => {
    if (!cg.applicationDate) return 0;
    return (Date.now() - new Date(cg.applicationDate).getTime()) / 60000;
  },
  isTaskDone: (cg, taskId) => isTaskDone(cg.tasks?.[taskId]),
  getDateField: (cg, field) => cg[field] || null,
  getPhaseTimestamp: (cg, phase) => cg.phaseTimestamps?.[phase] || null,
  getLastNoteDate: (cg) => {
    const notes = cg.notes || [];
    if (notes.length === 0) return null;
    return Math.max(...notes.map((n) => new Date(n.timestamp || n.date || 0).getTime()));
  },
  isTerminalPhase: () => false,
};

const clientAdapter = {
  entityType: 'client',
  getId: (cl) => cl.id,
  getName: (cl) => `${cl.firstName || ''} ${cl.lastName || ''}`.trim() || 'Unnamed',
  getPhase: (cl) => getClientPhase(cl),
  getDaysInPhase: (cl) => getDaysInClientPhase(cl),
  getDaysSinceCreation: (cl) => getDaysSinceCreated(cl),
  getMinutesSinceCreation: (cl) => {
    if (!cl.createdAt) return 0;
    const created = typeof cl.createdAt === 'number' ? cl.createdAt : new Date(cl.createdAt).getTime();
    return (Date.now() - created) / 60000;
  },
  isTaskDone: (cl, taskId) => clientIsTaskDone(cl.tasks?.[taskId]),
  getDateField: (cl, field) => cl[field] || null,
  getPhaseTimestamp: (cl, phase) => cl.phaseTimestamps?.[phase] || null,
  getLastNoteDate: (cl) => {
    const notes = cl.notes || [];
    if (notes.length === 0) return null;
    return Math.max(...notes.map((n) => new Date(n.timestamp || n.date || 0).getTime()));
  },
  isTerminalPhase: (cl) => {
    const phase = getClientPhase(cl);
    return phase === 'won' || phase === 'lost';
  },
};

// ─── Condition Evaluators ────────────────────────────────────
// Each returns { matches: boolean, context: {} } where context
// holds computed values for merge field resolution.

export function evaluatePhaseTime(entity, config, adapter) {
  const phase = adapter.getPhase(entity);
  const targetPhase = config.phase;

  // Handle _any_active for stale lead detection
  if (targetPhase === '_any_active') {
    const excludePhases = config.exclude_phases || [];
    if (excludePhases.includes(phase)) return { matches: false, context: {} };
  } else if (targetPhase && phase !== targetPhase) {
    return { matches: false, context: {} };
  }

  const daysInPhase = adapter.getDaysInPhase(entity);
  if (daysInPhase < (config.min_days || 0)) return { matches: false, context: {} };

  return {
    matches: true,
    context: { days_in_phase: daysInPhase, phase_name: phase },
  };
}

export function evaluateTaskIncomplete(entity, config, adapter) {
  const phase = adapter.getPhase(entity);
  if (config.phase && phase !== config.phase) return { matches: false, context: {} };

  // Task must NOT be done
  if (adapter.isTaskDone(entity, config.task_id)) return { matches: false, context: {} };

  // Optional time threshold
  const daysInPhase = adapter.getDaysInPhase(entity);
  const daysSinceCreation = adapter.getDaysSinceCreation(entity);
  const minDays = config.min_days || 0;

  // Use days since creation for intake-level checks, days in phase otherwise
  const relevantDays = config.phase ? daysInPhase : daysSinceCreation;
  if (relevantDays < minDays) return { matches: false, context: {} };

  return {
    matches: true,
    context: {
      days_in_phase: daysInPhase,
      days_since_created: daysSinceCreation,
      phase_name: phase,
      task_name: config.task_id,
    },
  };
}

export function evaluateTaskStale(entity, config, adapter) {
  const phase = adapter.getPhase(entity);
  if (config.phase && phase !== config.phase) return { matches: false, context: {} };

  // "Done" task must be completed
  if (!adapter.isTaskDone(entity, config.done_task_id)) return { matches: false, context: {} };

  // "Pending" task must NOT be completed
  if (adapter.isTaskDone(entity, config.pending_task_id)) return { matches: false, context: {} };

  // Time threshold based on phase timestamp
  const phaseStart = adapter.getPhaseTimestamp(entity, config.phase);
  if (!phaseStart) return { matches: false, context: {} };

  const daysSince = Math.floor((Date.now() - phaseStart) / 86400000);
  if (daysSince < (config.min_days || 0)) return { matches: false, context: {} };

  return {
    matches: true,
    context: { days_in_phase: daysSince, phase_name: phase },
  };
}

export function evaluateDateExpiring(entity, config, adapter) {
  const dateValue = adapter.getDateField(entity, config.field);
  if (!dateValue) return { matches: false, context: {} };

  const exp = new Date(dateValue + (dateValue.includes('T') ? '' : 'T00:00:00'));
  const daysUntil = Math.ceil((exp - new Date()) / 86400000);

  // For "expired" rules (days_until < 0)
  if (config.days_until !== undefined && config.days_until < 0) {
    if (daysUntil >= 0) return { matches: false, context: {} };
    return {
      matches: true,
      context: {
        days_until_expiry: Math.abs(daysUntil),
        expiry_date: exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      },
    };
  }

  // For "expiring soon" rules
  const daysWarning = config.days_warning || 30;
  const excludeUnder = config.days_exclude_under || 0;

  if (daysUntil < 0) return { matches: false, context: {} };
  if (daysUntil > daysWarning) return { matches: false, context: {} };
  if (excludeUnder > 0 && daysUntil <= excludeUnder) return { matches: false, context: {} };

  return {
    matches: true,
    context: {
      days_until_expiry: daysUntil,
      expiry_date: exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    },
  };
}

export function evaluateTimeSinceCreation(entity, config, adapter) {
  const phase = adapter.getPhase(entity);
  if (config.phase && phase !== config.phase) return { matches: false, context: {} };

  // Optional: also require a task to NOT be done
  if (config.task_not_done && adapter.isTaskDone(entity, config.task_not_done)) {
    return { matches: false, context: {} };
  }

  if (config.min_minutes) {
    const minutesSince = adapter.getMinutesSinceCreation(entity);
    if (minutesSince < config.min_minutes) return { matches: false, context: {} };
    return {
      matches: true,
      context: {
        minutes_since_created: Math.round(minutesSince),
        days_since_created: adapter.getDaysSinceCreation(entity),
        phase_name: phase,
      },
    };
  }

  if (config.min_days) {
    const daysSince = adapter.getDaysSinceCreation(entity);
    if (daysSince < config.min_days) return { matches: false, context: {} };
    return {
      matches: true,
      context: { days_since_created: daysSince, phase_name: phase },
    };
  }

  return { matches: false, context: {} };
}

export function evaluateLastNoteStale(entity, config, adapter) {
  const phase = adapter.getPhase(entity);
  if (config.phase && phase !== config.phase) return { matches: false, context: {} };

  const lastNoteTs = adapter.getLastNoteDate(entity);
  let daysSinceLastNote;

  if (lastNoteTs && lastNoteTs > 0) {
    daysSinceLastNote = Math.floor((Date.now() - lastNoteTs) / 86400000);
  } else {
    // No notes at all — use days since creation
    daysSinceLastNote = adapter.getDaysSinceCreation(entity);
  }

  if (daysSinceLastNote < (config.min_days || 0)) return { matches: false, context: {} };

  return {
    matches: true,
    context: { days_since_last_note: daysSinceLastNote, phase_name: phase },
  };
}

export function evaluateSprintDeadline(entity, config, adapter) {
  const phase = adapter.getPhase(entity);
  if (config.phase && phase !== config.phase) return { matches: false, context: {} };

  // Sprint start: use phase timestamp, or fall back to previous phase
  const sprintStart = adapter.getPhaseTimestamp(entity, config.phase);
  if (!sprintStart) return { matches: false, context: {} };

  const sprintDay = Math.floor((Date.now() - sprintStart) / 86400000);
  const warningDay = config.warning_day || 3;

  if (sprintDay < warningDay) return { matches: false, context: {} };

  const expiredDay = config.expired_day || 7;

  return {
    matches: true,
    context: {
      sprint_day: sprintDay,
      sprint_remaining: Math.max(0, expiredDay - sprintDay),
      days_in_phase: sprintDay,
      phase_name: phase,
    },
  };
}

// ─── Evaluator Registry ──────────────────────────────────────

const EVALUATORS = {
  phase_time: evaluatePhaseTime,
  task_incomplete: evaluateTaskIncomplete,
  task_stale: evaluateTaskStale,
  date_expiring: evaluateDateExpiring,
  time_since_creation: evaluateTimeSinceCreation,
  last_note_stale: evaluateLastNoteStale,
  sprint_deadline: evaluateSprintDeadline,
};

// ─── Template Resolution ─────────────────────────────────────

export function resolveTemplate(template, context) {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return context[key] !== undefined ? String(context[key]) : match;
  });
}

// ─── Urgency Escalation ──────────────────────────────────────

function resolveUrgency(rule, entity, adapter) {
  let urgency = rule.urgency;

  if (rule.urgency_escalation) {
    const esc = rule.urgency_escalation;
    const daysInPhase = adapter.getDaysInPhase(entity);
    const daysSinceCreation = adapter.getDaysSinceCreation(entity);
    const relevantDays = Math.max(daysInPhase, daysSinceCreation);

    if (esc.min_days && relevantDays >= esc.min_days && esc.urgency) {
      urgency = esc.urgency;
    }
  }

  return urgency;
}

// ─── Core Engine ─────────────────────────────────────────────

export function evaluateRulesForEntity(entity, rules, adapter) {
  const items = [];

  for (const rule of rules) {
    if (rule.entity_type !== adapter.entityType) continue;

    // Skip terminal phases for clients
    if (adapter.isTerminalPhase(entity)) continue;

    const evaluator = EVALUATORS[rule.condition_type];
    if (!evaluator) continue;

    try {
      const { matches, context } = evaluator(entity, rule.condition_config || {}, adapter);
      if (!matches) continue;

      const urgency = resolveUrgency(rule, entity, adapter);
      const name = adapter.getName(entity);

      // Add entity name to context for templates
      const fullContext = { ...context, name };

      const item = {
        // Universal fields
        entityId: adapter.getId(entity),
        entityType: adapter.entityType,
        name,
        urgency,
        icon: rule.icon || '📋',
        title: resolveTemplate(rule.title_template, fullContext),
        detail: resolveTemplate(rule.detail_template, fullContext),
        action: resolveTemplate(rule.action_template, fullContext),
        ruleId: rule.id,
        // Compatibility fields (so dashboards don't need to change)
        ...(adapter.entityType === 'caregiver'
          ? { cgId: adapter.getId(entity) }
          : {
              clientId: adapter.getId(entity),
              clientName: name,
              type: rule.id,
              message: resolveTemplate(rule.detail_template, fullContext),
              severity: urgency,
              phase: adapter.getPhase(entity),
            }),
      };

      items.push(item);
    } catch (err) {
      // Never let a bad rule crash the dashboard
      console.warn(`Action item rule error [${rule.id}]:`, err);
    }
  }

  return items;
}

function generateFromRules(entities, entityType) {
  const rules = _rulesCache;
  if (!rules || rules.length === 0) return null; // signal to use fallback

  const adapter = entityType === 'caregiver' ? caregiverAdapter : clientAdapter;
  const relevantRules = rules.filter((r) => r.entity_type === entityType);
  if (relevantRules.length === 0) return null;

  const items = [];
  for (const entity of entities) {
    const entityItems = evaluateRulesForEntity(entity, relevantRules, adapter);
    items.push(...entityItems);
  }

  items.sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
  return items;
}

// ─── Exports (Drop-in replacements) ──────────────────────────
// These match the exact signatures of the old hardcoded engines
// so dashboards can swap imports without any other changes.

import { generateActionItems as hardcodedCaregiverEngine } from './actionEngine';
import { generateClientActionItems as hardcodedClientEngine } from '../features/clients/actionEngine';

export function generateActionItems(caregivers) {
  const result = generateFromRules(caregivers, 'caregiver');
  if (result !== null) return result;
  // Fallback to hardcoded engine while rules are loading
  return hardcodedCaregiverEngine(caregivers);
}

export function generateClientActionItems(clients) {
  const result = generateFromRules(clients, 'client');
  if (result !== null) return result;
  // Fallback to hardcoded engine while rules are loading
  return hardcodedClientEngine(clients);
}
