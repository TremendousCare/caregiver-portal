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
