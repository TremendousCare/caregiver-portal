// ─── Planner Helpers (Node/Vitest compatible) ───
// Re-implements pure logic from _shared/operations/planner.ts for testing.

export function inferPhase(timestamps) {
  if (!timestamps || typeof timestamps !== 'object') return null;
  const phases = ['Intake', 'Interview', 'Onboarding', 'Verification', 'Orientation', 'Active Roster'];
  for (let i = phases.length - 1; i >= 0; i--) {
    const key = phases[i].toLowerCase().replace(/\s+/g, '_');
    if (timestamps[key]) return phases[i];
  }
  return null;
}

export function calculateDaysInPhase(timestamps, currentPhase, now) {
  if (!timestamps || typeof timestamps !== 'object') return 0;
  const key = currentPhase.toLowerCase().replace(/\s+/g, '_');
  const entered = timestamps[key];
  if (!entered) return 0;
  return Math.floor((now - new Date(entered).getTime()) / 86400000);
}

export function getLastContact(notes, createdAt, now) {
  let lastTs = new Date(createdAt || 0).getTime();
  let channel = null;
  for (const n of notes || []) {
    if (typeof n === 'string') continue;
    const ts = n.timestamp ? new Date(n.timestamp).getTime() : 0;
    if (ts > lastTs) {
      lastTs = ts;
      channel = n.type || n.direction || null;
    }
  }
  return { daysSince: Math.floor((now - lastTs) / 86400000), channel };
}

export function getTaskProgress(tasks) {
  if (!tasks || typeof tasks !== 'object') return { incomplete: [], total: 0, completed: 0 };
  const incomplete = [];
  let total = 0, completed = 0;
  for (const [taskId, taskData] of Object.entries(tasks)) {
    total++;
    if (taskData?.completed) completed++;
    else incomplete.push(taskId.replace(/^task_/, '').replace(/_/g, ' '));
  }
  return { incomplete, total, completed };
}

export function evaluateAlerts(entity, rules, entityType, now) {
  const alerts = [];
  const applicable = rules.filter(r => r.enabled && r.entity_type === entityType);
  for (const rule of applicable) {
    switch (rule.condition_type) {
      case 'task_missing': {
        const taskId = rule.condition_config?.task_id;
        if (taskId && entity.tasks && !entity.tasks[taskId]?.completed) alerts.push(rule.name);
        break;
      }
      case 'phase_time': {
        const days = rule.condition_config?.days || 7;
        const phase = entity.phase_override || entity.phase;
        const phaseKey = (phase || '').toLowerCase().replace(/\s+/g, '_');
        const entered = entity.phase_timestamps?.[phaseKey];
        if (entered) {
          const daysIn = Math.floor((now - new Date(entered).getTime()) / 86400000);
          if (daysIn >= days) alerts.push(rule.name);
        }
        break;
      }
      case 'date_expiry': {
        const field = rule.condition_config?.date_field;
        const warnDays = rule.condition_config?.warn_days || 30;
        if (field && entity[field]) {
          const expiry = new Date(entity[field]).getTime();
          const daysUntil = Math.floor((expiry - now) / 86400000);
          if (daysUntil <= warnDays) alerts.push(rule.name);
        }
        break;
      }
    }
  }
  return alerts;
}

export function getRecentOutcomes(entityId, outcomes) {
  return outcomes
    .filter(o => o.entity_id === entityId)
    .slice(0, 3)
    .map(o => `${(o.action_type || '').replace(/_/g, ' ')}: ${o.outcome_type || 'pending'}`);
}

const VALID_ACTION_TYPES = new Set([
  'send_sms', 'send_email', 'add_note', 'add_client_note',
  'update_phase', 'update_client_phase',
  'complete_task', 'complete_client_task',
  'update_caregiver_field', 'update_client_field',
  'update_board_status', 'create_calendar_event',
  'send_docusign_envelope',
]);

export function parsePlannerResponse(responseText) {
  let jsonStr = responseText.trim();
  const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  jsonStr = jsonMatch[0];
  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(item => item.entity_id && item.action_type && item.title && VALID_ACTION_TYPES.has(item.action_type))
    .map(item => ({
      entity_id: String(item.entity_id),
      entity_type: item.entity_type === 'client' ? 'client' : 'caregiver',
      entity_name: String(item.entity_name || 'Unknown'),
      action_type: item.action_type,
      priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
      title: String(item.title).slice(0, 200),
      detail: String(item.detail || '').slice(0, 500),
      drafted_content: item.drafted_content ? String(item.drafted_content) : null,
      action_params: item.action_params || {},
    }));
}

export function formatPipelineSummaryForPrompt(entities) {
  if (!entities || entities.length === 0) return 'No active entities in pipeline.';
  return entities.map(e => {
    const parts = [
      `${e.name} (${e.entity_type}, ${e.phase})`,
      `${e.days_in_phase}d in phase`,
      `last contact: ${e.days_since_contact}d ago${e.last_contact_channel ? ` via ${e.last_contact_channel}` : ''}`,
      `tasks: ${e.completed_tasks}/${e.total_tasks}`,
    ];
    if (e.incomplete_tasks.length > 0) parts.push(`pending: ${e.incomplete_tasks.slice(0, 3).join(', ')}`);
    if (e.active_alerts.length > 0) parts.push(`ALERTS: ${e.active_alerts.join(', ')}`);
    if (e.recent_outcomes.length > 0) parts.push(`outcomes: ${e.recent_outcomes.join('; ')}`);
    if (!e.has_phone) parts.push('NO PHONE');
    return `- [${e.id}] ${parts.join(' | ')}`;
  }).join('\n');
}
