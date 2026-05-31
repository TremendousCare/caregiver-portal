// ─── Care Signal pure helpers ──────────────────────────────────
//
// Display + transform logic for care signals. No I/O, no React — these
// are unit-tested and shared by the panel and (later) the briefing.
//
// The Stop-and-Watch category labels MIRROR the detector's taxonomy in
// supabase/functions/care-coordinator-sweep/stopAndWatch.ts. If you add
// a category there, add it here too (the test asserts the known set).

export const CATEGORY_LABELS = {
  seems_different: 'Seems different',
  talks_less: 'Talks less',
  overall_needs_more_help: 'Needs more help',
  pain: 'Pain',
  ate_less: 'Ate less',
  no_bowel_movement: 'No bowel movement',
  drank_less: 'Drank less',
  weight_change: 'Weight change',
  agitated: 'Agitated / confused',
  tired_drowsy: 'Tired / drowsy',
  skin_change: 'Change in skin',
  help_walking: 'Help walking / transfers',
  medication_concern: 'Medication concern',
};

export function categoryLabel(id) {
  return CATEGORY_LABELS[id] || id;
}

// Severity → display metadata. `icon` is the lucide-react component name
// the panel maps to a component (no emoji glyphs, per UI conventions).
export const SEVERITY_META = {
  urgent: { label: 'Urgent', icon: 'AlertOctagon', color: '#dc2626', bg: '#fef2f2', border: '#fca5a5', rank: 2 },
  watch: { label: 'Watch', icon: 'AlertTriangle', color: '#d97706', bg: '#fffbeb', border: '#fcd34d', rank: 1 },
  info: { label: 'Info', icon: 'Info', color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe', rank: 0 },
};

export function severityMeta(severity) {
  return SEVERITY_META[severity] || SEVERITY_META.info;
}

export function severityRank(severity) {
  return severityMeta(severity).rank;
}

// follow_up_tasks urgency enum is critical | warning | info. Map a care
// signal severity onto it so the spun-off task carries proportional
// urgency (urgent -> critical, watch -> warning, info -> info).
export function severityToTaskUrgency(severity) {
  if (severity === 'urgent') return 'critical';
  if (severity === 'watch') return 'warning';
  return 'info';
}

// Resolve a human-readable actor label from the app's currentUser
// object ({ displayName, email }), matching CarePlanPanel's convention.
// Use this for DISPLAY fields (disposition_by, event actor) — not for
// task assignment.
export function actorFromUser(currentUser) {
  return currentUser?.displayName || currentUser?.email || null;
}

// Resolve the assignee for a follow-up task created from a signal.
// MUST be email-first: follow_up_tasks.assigned_to is consumed by the
// notification dispatcher (notifications_user.user_email = assigned_to),
// the AI briefing, and the "My Day" filter — all of which match on
// email. Assigning a display name like "Jessica" would silently drop
// the task from every per-user, email-keyed flow. Mirrors the
// FollowUpContext composer (email || name).
export function assigneeFromUser(currentUser) {
  return currentUser?.email || currentUser?.displayName || null;
}

// Map a raw care_signals DB row (snake_case) to a camelCase view model.
export function mapSignalRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    carePlanId: row.care_plan_id ?? null,
    severity: row.severity,
    categories: Array.isArray(row.categories) ? row.categories : [],
    summary: row.summary || '',
    sbar: row.sbar || null,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    windowStart: row.window_start ?? null,
    windowEnd: row.window_end ?? null,
    status: row.status || 'open',
    dispositionNote: row.disposition_note ?? null,
    dispositionedBy: row.dispositioned_by ?? null,
    dispositionedAt: row.dispositioned_at ?? null,
    followUpTaskId: row.follow_up_task_id ?? null,
    createdAt: row.created_at ?? null,
    model: row.model ?? null,
  };
}

// Open worklist ordering: most severe first, then newest.
export function sortSignals(signals) {
  return [...(signals || [])].sort((a, b) => {
    const r = severityRank(b.severity) - severityRank(a.severity);
    if (r !== 0) return r;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
}

// Render the SBAR object as plain text for copy-to-clipboard / a note.
// Always labels it as decision support, never diagnosis.
export function sbarToText(sbar, { clientName } = {}) {
  if (!sbar || typeof sbar !== 'object') return '';
  const lines = [];
  lines.push(clientName ? `SBAR — ${clientName}` : 'SBAR');
  lines.push('');
  if (sbar.situation) lines.push(`Situation: ${sbar.situation}`);
  if (sbar.background) lines.push(`Background: ${sbar.background}`);
  if (sbar.assessment) lines.push(`Assessment: ${sbar.assessment}`);
  if (sbar.recommendation) lines.push(`Recommendation: ${sbar.recommendation}`);
  lines.push('');
  lines.push('(AI-generated decision support for staff review — not a diagnosis.)');
  return lines.join('\n');
}

// Build the createUserTask() input from a signal (human-initiated
// spin-off). Creator is the assignee (follow_up_tasks v1 convention,
// handled inside createUserTask). Due now-ish so it lands in TODAY.
export function buildTaskInputFromSignal(signal, { clientName, createdBy, now = new Date() } = {}) {
  if (!signal) return null;
  const who = clientName || 'client';
  const cats = (signal.categories || []).map(categoryLabel).join(', ');
  const sevLabel = severityMeta(signal.severity).label;
  const detailParts = [signal.summary].filter(Boolean);
  if (cats) detailParts.push(`Signals: ${cats}.`);
  if (signal.sbar?.recommendation) detailParts.push(`Recommended: ${signal.sbar.recommendation}`);
  return {
    title: `Review care signal (${sevLabel}) — ${who}`,
    description: detailParts.join(' '),
    urgency: severityToTaskUrgency(signal.severity),
    dueAt: new Date(now).toISOString(),
    clientId: signal.clientId,
    createdBy: createdBy || null,
  };
}

// A short, human one-liner describing an evidence row.
export function describeEvidence(ev) {
  if (!ev) return '';
  const label = ev.task_name ? `${ev.task_name} — ${ev.type}` : ev.type;
  const rating = ev.rating ? ` [${ev.rating}]` : '';
  const note = ev.note ? ` — "${ev.note}"` : '';
  return `${label}${rating}${note}`.trim();
}
