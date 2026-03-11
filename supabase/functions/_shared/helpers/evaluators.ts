// --- Shared Action Item Evaluators ---
// Pure functions for evaluating action item rules against entities.
// No DB calls, no side effects.
// Ported from src/lib/actionItemEngine.js (Phase 4 extraction).

import type {
  EntityAdapter,
  EvaluatorResult,
  ConditionConfig,
  EvaluatorFn,
  ActionItemRule,
  ActionItem,
} from "./evaluators.types.ts";

export type {
  EntityAdapter,
  EvaluatorResult,
  ConditionConfig,
  EvaluatorFn,
  ActionItemRule,
  ActionItem,
};

export const URGENCY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export function evaluatePhaseTime(entity: any, config: ConditionConfig, adapter: EntityAdapter): EvaluatorResult {
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

export function evaluateTaskIncomplete(entity: any, config: ConditionConfig, adapter: EntityAdapter): EvaluatorResult {
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

export function evaluateTaskStale(entity: any, config: ConditionConfig, adapter: EntityAdapter): EvaluatorResult {
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

export function evaluateDateExpiring(entity: any, config: ConditionConfig, adapter: EntityAdapter): EvaluatorResult {
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

export function evaluateTimeSinceCreation(entity: any, config: ConditionConfig, adapter: EntityAdapter): EvaluatorResult {
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

export function evaluateLastNoteStale(entity: any, config: ConditionConfig, adapter: EntityAdapter): EvaluatorResult {
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

export function evaluateSprintDeadline(entity: any, config: ConditionConfig, adapter: EntityAdapter): EvaluatorResult {
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

export const EVALUATORS: Record<string, EvaluatorFn> = {
  phase_time: evaluatePhaseTime,
  task_incomplete: evaluateTaskIncomplete,
  task_stale: evaluateTaskStale,
  date_expiring: evaluateDateExpiring,
  time_since_creation: evaluateTimeSinceCreation,
  last_note_stale: evaluateLastNoteStale,
  sprint_deadline: evaluateSprintDeadline,
};

export function resolveTemplate(template: string | null | undefined, context: Record<string, any>): string {
  if (!template) return "";
  return template.replace(/\{\{(\w+)\}\}/g, (match: string, key: string) => {
    return context[key] !== undefined ? String(context[key]) : match;
  });
}

export function resolveUrgency(rule: ActionItemRule, entity: any, adapter: EntityAdapter): string {
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

export function evaluateRulesForEntity(entity: any, rules: ActionItemRule[], adapter: EntityAdapter): ActionItem[] {
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