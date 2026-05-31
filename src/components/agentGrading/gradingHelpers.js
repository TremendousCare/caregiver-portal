// Phase 1.5 — pure helpers for the grading UI.
//
// Kept separate from the React component so the logic is testable
// without rendering. Mirrors the autonomy-v2 module's pure-helper
// pattern.

export const VERDICTS = ['good', 'bad', 'harmful'];

/**
 * Reduce a list of append-only grade rows down to the latest verdict
 * per suggestion_id. Returns a Map keyed by suggestion_id.
 *
 *   `grades`  — rows shaped { suggestion_id, verdict, graded_at, ... }
 *
 * Used by the page so each row in the table can show its current grade
 * even when the operator re-grades and the history accumulates extra
 * rows.
 */
export function latestGradeBySuggestion(grades) {
  const out = new Map();
  if (!Array.isArray(grades)) return out;
  for (const g of grades) {
    if (!g || !g.suggestion_id || !g.graded_at) continue;
    const prior = out.get(g.suggestion_id);
    if (!prior || Date.parse(g.graded_at) > Date.parse(prior.graded_at)) {
      out.set(g.suggestion_id, g);
    }
  }
  return out;
}

/**
 * Apply the `ungradedOnly` toggle to a suggestions list. Pure — split
 * out so the React layer doesn't have inline filter logic.
 */
export function applyUngradedFilter(suggestions, latestGrades, ungradedOnly) {
  if (!ungradedOnly) return suggestions;
  return suggestions.filter((s) => !latestGrades.has(s.id));
}

/**
 * Derive the unique set of action_types from a suggestions list, for
 * populating the action_type filter dropdown. Sorted alphabetically;
 * NULL action_types are excluded.
 */
export function uniqueActionTypes(suggestions) {
  const seen = new Set();
  for (const s of suggestions || []) {
    if (s.action_type) seen.add(s.action_type);
  }
  return Array.from(seen).sort();
}

/** Short, single-line preview of an arbitrary string. */
export function truncate(s, n = 140) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(0, n - 1) + '…';
}

/**
 * Format a count-by-verdict summary for the bulk-grade bar.
 * Returns { good, bad, harmful, ungraded } over the filtered visible
 * suggestion set.
 */
export function gradeBreakdown(suggestions, latestGrades) {
  const counts = { good: 0, bad: 0, harmful: 0, ungraded: 0 };
  for (const s of suggestions || []) {
    const g = latestGrades.get(s.id);
    if (!g) counts.ungraded++;
    else if (g.verdict === 'good') counts.good++;
    else if (g.verdict === 'bad') counts.bad++;
    else if (g.verdict === 'harmful') counts.harmful++;
  }
  return counts;
}

/**
 * Coerce a verdict-or-null into a stable CSS class suffix. Used in
 * both the page render and tests.
 */
export function verdictClass(verdict) {
  if (verdict === 'good') return 'good';
  if (verdict === 'bad') return 'bad';
  if (verdict === 'harmful') return 'harmful';
  return 'ungraded';
}

// ─── Entity-name resolution ───
//
// Several writers leave `ai_suggestions.entity_name` NULL (call_analyst
// always does; some message-router paths do too — see
// `persistCallAnalysis.ts`). The grading page only ever had `entity_id`
// + `entity_type` to show, which rendered as a bare "—". These helpers
// resolve a display name from the caregivers / clients tables so the
// operator can see WHO a suggestion is about. Mirrors the lead-name
// fallback in `_shared/helpers/leadNotifications.ts::leadDisplayName`.

/**
 * Best-effort display name for a caregiver or client record. Returns
 * null (not a placeholder) when nothing usable is present so callers
 * can fall back to the existing "—" rendering.
 */
export function entityDisplayName(entityType, record) {
  if (!record) return null;
  const first = (record.first_name || '').trim();
  const last = (record.last_name || '').trim();
  if (first || last) return `${first} ${last}`.trim();
  if (entityType === 'client') {
    const contact = (record.contact_name || '').trim();
    if (contact) return contact;
    const recipient = (record.care_recipient_name || '').trim();
    if (recipient) return recipient;
  }
  return null;
}

/**
 * Collect the distinct caregiver / client ids that still need a name
 * resolved (entity_id present, entity_name missing). Returns arrays so
 * the caller can pass them straight to an `.in(...)` query.
 */
export function collectEntityIds(suggestions) {
  const caregiverIds = new Set();
  const clientIds = new Set();
  for (const s of suggestions || []) {
    if (!s || !s.entity_id || s.entity_name) continue;
    if (s.entity_type === 'caregiver') caregiverIds.add(s.entity_id);
    else if (s.entity_type === 'client') clientIds.add(s.entity_id);
  }
  return { caregiverIds: Array.from(caregiverIds), clientIds: Array.from(clientIds) };
}

/**
 * Build a `${entity_type}:${entity_id}` → display-name Map from raw
 * caregiver / client record arrays. Skips records that resolve to no
 * usable name.
 */
export function buildEntityNameMap({ caregivers, clients } = {}) {
  const map = new Map();
  for (const c of caregivers || []) {
    if (!c || !c.id) continue;
    const name = entityDisplayName('caregiver', c);
    if (name) map.set(`caregiver:${c.id}`, name);
  }
  for (const c of clients || []) {
    if (!c || !c.id) continue;
    const name = entityDisplayName('client', c);
    if (name) map.set(`client:${c.id}`, name);
  }
  return map;
}

/**
 * Return a copy of `suggestions` with `entity_name` filled in from
 * `nameMap` where it was missing. Rows that already have a name, or
 * have no resolvable name, are returned unchanged.
 */
export function attachEntityNames(suggestions, nameMap) {
  if (!Array.isArray(suggestions)) return [];
  if (!nameMap || nameMap.size === 0) return suggestions;
  return suggestions.map((s) => {
    if (!s || s.entity_name || !s.entity_id || !s.entity_type) return s;
    const resolved = nameMap.get(`${s.entity_type}:${s.entity_id}`);
    return resolved ? { ...s, entity_name: resolved } : s;
  });
}
