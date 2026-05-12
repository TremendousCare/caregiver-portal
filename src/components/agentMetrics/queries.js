// Phase 1.4 — Supabase queries for the agent metrics dashboard.
//
// All queries are read-only (no writes — Phase 1.4 is a pure UI surface).
// `agent_actions` is service-role-write-only by design (Phase 1.1.A) but
// `authenticated` retains SELECT.

const ACTION_COLUMNS = `
  id,
  org_id,
  agent_id,
  agent_version,
  action_type,
  phase,
  entity_type,
  entity_id,
  actor,
  payload,
  outcome_id,
  created_at,
  chain_seq
`;

const OUTCOME_COLUMNS = `
  id,
  agent_id,
  action_type,
  entity_type,
  entity_id,
  outcome_type,
  source,
  expires_at,
  outcome_detected_at,
  created_at
`;

const AGENT_COLUMNS = `
  id,
  slug,
  name,
  version,
  model,
  kill_switch,
  shadow_mode,
  read_only_mode
`;

/** Load every agent for the per-agent selector. */
export async function loadAgentsForMetrics(supabase) {
  const { data, error } = await supabase
    .from('agents')
    .select(AGENT_COLUMNS)
    .order('slug', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Load all agent_actions for a given agent over a date range.
 * Range is [sinceIso, now). Order by chain_seq so callers get stable
 * pagination semantics (chain_seq is strictly monotonic per Phase 1.1.B).
 */
export async function loadAgentActions(supabase, { agentId, sinceIso }) {
  if (!agentId || !sinceIso) return [];
  const { data, error } = await supabase
    .from('agent_actions')
    .select(ACTION_COLUMNS)
    .eq('agent_id', agentId)
    .gte('created_at', sinceIso)
    .order('chain_seq', { ascending: true })
    .limit(5000);
  if (error) throw error;
  return data || [];
}

/**
 * Load action_outcomes for the given agent. The dashboard joins these
 * to actions via `agent_actions.outcome_id` to compute verified-outcome
 * rate.
 *
 * Note: `action_outcomes.agent_id` was added in Phase 0.4 and is
 * nullable on legacy rows. We filter on it here so newly-stamped
 * outcomes show up; legacy unstamped rows are invisible to the
 * dashboard (acceptable — they pre-date the metrics surface).
 */
export async function loadActionOutcomes(supabase, { agentId, sinceIso }) {
  if (!agentId || !sinceIso) return [];
  const { data, error } = await supabase
    .from('action_outcomes')
    .select(OUTCOME_COLUMNS)
    .eq('agent_id', agentId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(5000);
  if (error) throw error;
  return data || [];
}

/**
 * Compute the ISO timestamp for the start of the window. Pure — exported
 * for tests to keep deterministic.
 */
export function windowStartIso(days, now = Date.now()) {
  const ms = days * 24 * 60 * 60 * 1000;
  return new Date(now - ms).toISOString();
}
