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

// Save manifest edits via the update_agent_manifest_v1 RPC. The RPC
// enforces admin-only, optimistic version locking, and the editable-
// fields allowlist. See migration
// 20260510020000_..._update_agent_manifest_rpc.sql for the contract.
//
// Errors surfaced to caller (hook decides render):
//   - sqlstate 42501 — not admin / cross-org / missing JWT org_id
//   - sqlstate P0001 — version conflict (UI shows reload-and-retry)
//   - sqlstate P0002 — agent not found
//   - sqlstate 22023 — invalid input (empty change_summary etc.)
//
// Returns the new version number (integer).
export async function updateAgentManifest(supabase, {
  agentId, expectedVersion, updates, changeSummary,
}) {
  if (!agentId) throw new Error('updateAgentManifest: agentId required');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('updateAgentManifest: expectedVersion must be a positive integer');
  }
  if (!updates || typeof updates !== 'object') {
    throw new Error('updateAgentManifest: updates must be an object');
  }
  if (!changeSummary || !String(changeSummary).trim()) {
    throw new Error('updateAgentManifest: changeSummary required');
  }

  const { data, error } = await supabase.rpc('update_agent_manifest_v1', {
    p_agent_id:         agentId,
    p_expected_version: expectedVersion,
    p_updates:          updates,
    p_change_summary:   String(changeSummary).trim(),
  });

  if (error) throw error;
  return data; // integer — the new version
}

// Revert an agent's editable fields to a prior version's snapshot via
// the revert_agent_to_version_v1 RPC. Excluded fields (kill_switch,
// shadow_mode, slug, identity, triggers) are never touched.
//
// Errors:
//   - sqlstate 42501 — not admin / cross-org
//   - sqlstate P0002 — agent or target version not found
//   - sqlstate 22023 — target == current (no-op revert blocked)
//                     | empty change_summary | bad target_version
//
// Returns the new version number (integer). The historical snapshot
// row at p_target_version is never edited.
export async function revertAgentToVersion(supabase, {
  agentId, targetVersion, changeSummary,
}) {
  if (!agentId) throw new Error('revertAgentToVersion: agentId required');
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new Error('revertAgentToVersion: targetVersion must be a positive integer');
  }
  if (!changeSummary || !String(changeSummary).trim()) {
    throw new Error('revertAgentToVersion: changeSummary required');
  }

  const { data, error } = await supabase.rpc('revert_agent_to_version_v1', {
    p_agent_id:       agentId,
    p_target_version: targetVersion,
    p_change_summary: String(changeSummary).trim(),
  });

  if (error) throw error;
  return data; // integer — the new version
}

// Detect a version-conflict error from the RPC. The migration raises
// with sqlstate P0001 and a message containing "agent_version_conflict";
// supabase surfaces both .code and .message. Check both for resilience.
export function isVersionConflict(err) {
  if (!err) return false;
  if (err.code === 'P0001') return true;
  if (typeof err.message === 'string' && err.message.includes('agent_version_conflict')) {
    return true;
  }
  return false;
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
