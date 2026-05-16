// ─── AI Priorities — Pure Logic ───
// Testable functions for per-entity recommendations (profile card)
// and last-activity computation (reused by /pipeline-health).
// No React, no Supabase — just data transformation.
//
// NOTE: `buildPriorityItems` was retired alongside the
// AIPrioritiesPanel sidebar widget when the Pipeline Health UI
// shipped (replaces the AI-as-attention-grabber pattern with a
// pipeline-state view at /pipeline-health). The remaining exports
// — `getLastActivityTimestamp`, `computeStaleCaregivers`,
// `getRecommendation` — are reused by `pipelineHealth.js` and
// `RecommendedNextStep.jsx`.

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
