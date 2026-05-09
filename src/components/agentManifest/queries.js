// Phase 0.5 PR A — pure supabase query helpers for the agent manifest UI.
//
// These are thin wrappers around the supabase client that the hooks
// (useAgents, useAgentVersions, useToggleAgentFlag) call. Pulling them
// out makes them easy to mock in component-level tests and keeps the
// hook bodies focused on React state, not query plumbing.

const AGENT_COLUMNS = `
  id,
  org_id,
  slug,
  name,
  version,
  system_prompt,
  tool_allowlist,
  autonomy_profile,
  context_recipe,
  model,
  max_iterations,
  kill_switch,
  shadow_mode,
  outcome_definition,
  triggers,
  created_at,
  updated_at,
  created_by,
  updated_by
`;

const AGENT_VERSION_COLUMNS = `
  id,
  agent_id,
  agent_slug,
  version,
  snapshot,
  change_summary,
  changed_by,
  changed_at
`;

// Load every agent visible to the current org, ordered by slug for a
// stable display. RLS scopes this to the JWT's org_id.
export async function loadAgents(supabase) {
  const { data, error } = await supabase
    .from('agents')
    .select(AGENT_COLUMNS)
    .order('slug', { ascending: true });

  if (error) throw error;
  return data || [];
}

// Load the version history for a specific agent, newest first.
export async function loadAgentVersions(supabase, agentId) {
  if (!agentId) return [];
  const { data, error } = await supabase
    .from('agent_versions')
    .select(AGENT_VERSION_COLUMNS)
    .eq('agent_id', agentId)
    .order('version', { ascending: false });

  if (error) throw error;
  return data || [];
}

// Flip kill_switch or shadow_mode on an agent. Calls the
// toggle_agent_flag_v1 RPC which (a) enforces admin-only via is_admin(),
// (b) verifies the JWT org matches the agent's org, (c) writes an
// audit row to events on real state transitions. Returns the new value
// the function set on the row.
//
// Errors:
//   - sqlstate 42501 — caller is not an admin or org mismatch
//   - sqlstate 22023 — invalid flag name (frontend validates first;
//     this is defense-in-depth)
//   - sqlstate P0002 — agent not found
//
// We surface the underlying error to the caller; the hook decides how
// to render it (toast, inline message, etc).
export async function toggleAgentFlag(supabase, { agentId, flag, value }) {
  if (!agentId) throw new Error('toggleAgentFlag: agentId required');
  if (flag !== 'kill_switch' && flag !== 'shadow_mode') {
    throw new Error(`toggleAgentFlag: invalid flag "${flag}"`);
  }

  const { data, error } = await supabase.rpc('toggle_agent_flag_v1', {
    p_agent_id: agentId,
    p_flag: flag,
    p_value: !!value,
  });

  if (error) throw error;
  return data; // boolean — the new value the function set
}

// Display helper: short summary string for an agent row.
export function summariseAgent(agent) {
  if (!agent) return '';
  const tools = Array.isArray(agent.tool_allowlist) ? agent.tool_allowlist.length : 0;
  const cron = agent?.triggers?.cron || null;
  const parts = [
    agent.slug,
    `${tools} tools`,
    shortModel(agent.model),
  ];
  if (cron) parts.push(`cron ${cron}`);
  return parts.filter(Boolean).join(' · ');
}

// Status helper: which color/state dot to show for an agent row.
//   live    — kill_switch=false, shadow_mode=false (normal operation)
//   dormant — kill_switch=true (return-immediately, no Claude call)
//   shadow  — shadow_mode=true (loop runs but writes go to ai_suggestions)
export function agentStatus(agent) {
  if (!agent) return 'unknown';
  if (agent.kill_switch) return 'dormant';
  if (agent.shadow_mode) return 'shadow';
  return 'live';
}

function shortModel(model) {
  if (!model) return '';
  // claude-sonnet-4-5-20250929 → sonnet-4.5
  // claude-haiku-4-5-20251001  → haiku-4.5
  const match = String(model).match(/^claude-(sonnet|haiku|opus)-(\d+)-(\d+)/i);
  if (!match) return model;
  return `${match[1].toLowerCase()}-${match[2]}.${match[3]}`;
}
