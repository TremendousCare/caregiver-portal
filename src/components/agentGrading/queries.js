// Phase 1.5 — Supabase queries for the retrospective grading UI.
//
// Reads `ai_suggestions` + `ai_suggestion_grades` and writes only via
// the `upsert_ai_suggestion_grade_v1` SECURITY DEFINER RPC (the table
// has INSERT/UPDATE/DELETE revoked from authenticated — see the
// Phase 1.5 migrations).

const SUGGESTION_COLUMNS = `
  id,
  agent_id,
  source_type,
  suggestion_type,
  action_type,
  title,
  detail,
  drafted_content,
  action_params,
  intent,
  intent_confidence,
  entity_type,
  entity_id,
  entity_name,
  autonomy_level,
  status,
  created_at,
  resolved_at,
  resolved_by
`;

const GRADE_COLUMNS = `
  id,
  suggestion_id,
  verdict,
  rationale,
  graded_by,
  graded_at
`;

/**
 * Load all agents for the per-agent filter dropdown. Shape matches
 * the metrics dashboard's loader so we can swap in a shared helper
 * later if it grows.
 */
export async function loadAgentsForGrading(supabase) {
  const { data, error } = await supabase
    .from('agents')
    .select('id, slug, name, version, kill_switch, shadow_mode, read_only_mode')
    .order('slug', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Load the suggestions that the operator might grade.
 *
 * Filters:
 *   - agentId       — required-ish (the page defaults to first agent)
 *   - sourceType    — optional (proactive | inbound_sms | inbound_email | outcome)
 *   - actionType    — optional, exact match
 *   - sinceIso      — optional lower bound on created_at
 *   - beforeIso     — optional upper bound on created_at, exclusive.
 *                     The hook uses this as a paging cursor when
 *                     `ungradedOnly` is on so older ungraded rows are
 *                     reachable beyond the first `limit` page.
 *   - limit         — default 100, max 500
 *
 * `ungradedOnly` is applied client-side after grades are joined — keeps
 * the query simple and avoids a NOT EXISTS that PostgREST can't easily
 * express.
 */
export async function loadSuggestions(supabase, {
  agentId,
  sourceType = null,
  actionType = null,
  sinceIso = null,
  beforeIso = null,
  limit = 100,
}) {
  if (!agentId) return [];
  let q = supabase
    .from('ai_suggestions')
    .select(SUGGESTION_COLUMNS)
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (sourceType) q = q.eq('source_type', sourceType);
  if (actionType) q = q.eq('action_type', actionType);
  if (sinceIso) q = q.gte('created_at', sinceIso);
  if (beforeIso) q = q.lt('created_at', beforeIso);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

/**
 * Load every grade for the given suggestion ids. Append-only history
 * — callers compute "current" via the latest graded_at per
 * suggestion_id (see `latestGradePerSuggestion` in gradingHelpers.js).
 */
export async function loadGrades(supabase, { suggestionIds }) {
  if (!suggestionIds || suggestionIds.length === 0) return [];
  const { data, error } = await supabase
    .from('ai_suggestion_grades')
    .select(GRADE_COLUMNS)
    .in('suggestion_id', suggestionIds)
    .order('graded_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Append a grade row via the SECURITY DEFINER RPC. Admin-only at the
 * RPC layer; returns the new grade's id.
 */
export async function upsertGrade(supabase, { suggestionId, verdict, rationale }) {
  const { data, error } = await supabase.rpc('upsert_ai_suggestion_grade_v1', {
    p_suggestion_id: suggestionId,
    p_verdict: verdict,
    p_rationale: rationale || null,
  });
  if (error) throw error;
  return data; // grade id
}

/**
 * Compute the ISO timestamp for the start of a "last N days" window.
 * Pure — exported for tests.
 */
export function sinceIsoForDays(days, now = Date.now()) {
  if (!days || days <= 0) return null;
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}
