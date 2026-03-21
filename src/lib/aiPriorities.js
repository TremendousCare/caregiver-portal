// ─── AI Priorities — Pure Logic ───
// Testable functions for building priority items (dashboard)
// and per-entity recommendations (profile card).
// No React, no Supabase — just data transformation.

// ─── Action type display config (mirrors NotificationCenter) ───
const ACTION_ICONS = {
  send_sms: '\u{1F4F1}',
  send_email: '\u{1F4E7}',
  add_note: '\u{1F4DD}',
  update_phase: '\u{1F4C8}',
  complete_task: '\u2705',
  create_calendar_event: '\u{1F4C5}',
  send_docusign_envelope: '\u{1F58A}\uFE0F',
};

const ACTION_CTA_LABELS = {
  send_sms: 'Send SMS',
  send_email: 'Send Email',
  add_note: 'Add Note',
  update_phase: 'Move Phase',
  complete_task: 'Complete Task',
  create_calendar_event: 'Schedule',
  send_docusign_envelope: 'Send DocuSign',
};

// ─── Get last activity timestamp from caregiver ───

export function getLastActivityTimestamp(caregiver) {
  if (!caregiver) return 0;

  let lastTs = caregiver.created_at
    ? new Date(caregiver.created_at).getTime()
    : 0;

  const notes = caregiver.notes;
  if (!Array.isArray(notes)) return lastTs;

  for (const n of notes) {
    if (!n || typeof n === 'string') continue;
    const ts = n.timestamp
      ? (typeof n.timestamp === 'number' ? n.timestamp : new Date(n.timestamp).getTime())
      : 0;
    if (ts > lastTs) lastTs = ts;
  }

  return lastTs;
}

// ─── Compute stale caregivers ───

export function computeStaleCaregivers(caregivers, thresholdDays = 3) {
  if (!Array.isArray(caregivers)) return [];

  const now = Date.now();
  const thresholdMs = thresholdDays * 86400000;
  const stale = [];

  for (const cg of caregivers) {
    if (cg.archived) continue;
    // Skip active roster / deployed caregivers
    if (cg.board_status === 'deployed' || cg.board_status === 'reserve') continue;
    // Skip records with no name (test/incomplete data)
    if (!cg.first_name && !cg.last_name) continue;

    const lastActivity = getLastActivityTimestamp(cg);
    const elapsed = now - lastActivity;

    if (elapsed >= thresholdMs) {
      const daysSince = Math.floor(elapsed / 86400000);
      const name = `${cg.first_name || ''} ${cg.last_name || ''}`.trim() || 'Unknown';
      stale.push({ caregiver: cg, daysSinceActivity: daysSince, name });
    }
  }

  // Sort: most stale first
  stale.sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);
  return stale;
}

// ─── Build priority items for dashboard ───

export function buildPriorityItems(aiSuggestions, caregivers) {
  const items = [];
  const seenEntityIds = new Set();

  // 1. Pending AI suggestions (highest priority)
  for (const sug of (aiSuggestions || [])) {
    const urgency = sug.title?.includes('[HIGH]') ? 'critical'
      : sug.title?.includes('[LOW]') ? 'info'
      : 'warning';

    items.push({
      id: `sug_${sug.id}`,
      type: 'suggestion',
      icon: ACTION_ICONS[sug.action_type] || '\u26A1',
      title: (sug.title || 'AI Suggestion').replace(/^\[(HIGH|MEDIUM|LOW)\]\s*/, ''),
      reason: sug.detail || 'AI-recommended action',
      urgency,
      entityId: sug.entity_id,
      entityName: sug.entity_name || 'Unknown',
      ctaLabel: ACTION_CTA_LABELS[sug.action_type] || 'Review',
      ctaAction: 'view_profile',
      suggestionId: sug.id,
    });

    if (sug.entity_id) seenEntityIds.add(sug.entity_id);
  }

  // 2. Stale caregivers (only if not already covered by a suggestion)
  const staleCaregivers = computeStaleCaregivers(caregivers || []);
  for (const { caregiver, daysSinceActivity, name } of staleCaregivers) {
    if (seenEntityIds.has(caregiver.id)) continue;

    items.push({
      id: `stale_${caregiver.id}`,
      type: 'stale',
      icon: '\u{1F551}',  // clock
      title: `${name} — no activity in ${daysSinceActivity} days`,
      reason: 'Consider following up to keep onboarding moving',
      urgency: daysSinceActivity >= 7 ? 'critical' : 'warning',
      entityId: caregiver.id,
      entityName: name,
      ctaLabel: 'View Profile',
      ctaAction: 'view_profile',
      suggestionId: null,
    });
  }

  // Sort: critical > warning > info
  const urgencyOrder = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => (urgencyOrder[a.urgency] ?? 1) - (urgencyOrder[b.urgency] ?? 1));

  return items.slice(0, 5);
}

// ─── Get recommendation for a specific caregiver ───

export function getRecommendation(suggestion, caregiver) {
  // If we have a pending AI suggestion, use it
  if (suggestion) {
    return {
      title: (suggestion.title || 'AI Suggestion').replace(/^\[(HIGH|MEDIUM|LOW)\]\s*/, ''),
      reason: suggestion.detail || 'AI-recommended action',
      risk: null,
      ctaLabel: ACTION_CTA_LABELS[suggestion.action_type] || 'Review',
      ctaType: 'primary',
      source: 'ai',
      actionType: suggestion.action_type,
      draftedContent: suggestion.drafted_content,
      evidence: [
        suggestion.detail,
        suggestion.drafted_content ? `Draft: "${suggestion.drafted_content}"` : null,
      ].filter(Boolean),
    };
  }

  // Heuristic fallbacks
  if (!caregiver) {
    return {
      title: 'No data available',
      reason: '',
      risk: null,
      ctaLabel: 'Ask AI',
      ctaType: 'secondary',
      source: 'heuristic',
      actionType: null,
      draftedContent: null,
      evidence: [],
    };
  }

  const lastActivity = getLastActivityTimestamp(caregiver);
  const daysSince = Math.floor((Date.now() - lastActivity) / 86400000);

  // Check all tasks complete
  const tasks = caregiver.tasks;
  if (tasks && typeof tasks === 'object') {
    const entries = Object.entries(tasks);
    const allComplete = entries.length > 0 && entries.every(([, t]) => t?.completed);
    if (allComplete) {
      return {
        title: 'Ready for next phase',
        reason: 'All tasks in the current phase are complete',
        risk: 'May delay onboarding if not advanced promptly',
        ctaLabel: 'View Tasks',
        ctaType: 'primary',
        source: 'heuristic',
        actionType: 'update_phase',
        draftedContent: null,
        evidence: [`${entries.length} tasks completed`],
      };
    }
  }

  // Stale — no activity in 3+ days
  if (daysSince >= 3) {
    return {
      title: 'Consider sending a follow-up',
      reason: `No activity in ${daysSince} days`,
      risk: daysSince >= 7 ? 'At risk of losing this candidate' : null,
      ctaLabel: caregiver.phone ? 'Send SMS' : 'Send Email',
      ctaType: 'primary',
      source: 'heuristic',
      actionType: caregiver.phone ? 'send_sms' : 'send_email',
      draftedContent: null,
      evidence: [`Last activity: ${daysSince} days ago`],
    };
  }

  // Default — on track
  return {
    title: 'On track',
    reason: 'No urgent action needed',
    risk: null,
    ctaLabel: 'Ask AI',
    ctaType: 'secondary',
    source: 'heuristic',
    actionType: null,
    draftedContent: null,
    evidence: [],
  };
}
