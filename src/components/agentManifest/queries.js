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
  read_only_mode,
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

// Flip kill_switch or shadow_mode on an agent. Phase 1.1.B routes
// this through the `agent-flag-toggle` edge function so the toggle
// (toggle_agent_flag_v1) and the tamper-evident audit row
// (record_agent_action_v1) happen server-side in a single request.
//
// Pre-1.1.B this called supabase.rpc('toggle_agent_flag_v1') directly.
// That still works at the database layer, but bypasses the audit-log
// dual-write — the chain would have a gap. The edge function is now
// the canonical client surface.
//
// Errors:
//   - 401 — missing/invalid session
//   - 403 — non-admin or wrong org
//   - 400 — bad request shape
//   - 500 — internal (toggle RPC failure surfaced as 500 unless 42501)
//
// Returns: { new_value, audit_id?, audit_failed }. audit_failed=true
// means the toggle landed but the audit row didn't — the chain has
// a gap that the verifier (1.1.C will detect) might surface later.
export async function toggleAgentFlag(supabase, { agentId, flag, value }) {
  if (!agentId) throw new Error('toggleAgentFlag: agentId required');
  // Phase 1.3 added 'read_only_mode' alongside the original two flags.
  if (
    flag !== 'kill_switch' &&
    flag !== 'shadow_mode' &&
    flag !== 'read_only_mode'
  ) {
    throw new Error(`toggleAgentFlag: invalid flag "${flag}"`);
  }

  const { data, error } = await supabase.functions.invoke('agent-flag-toggle', {
    body: { agent_id: agentId, flag, value: !!value },
  });

  if (error) throw error;
  if (!data || data.success !== true) {
    const err = new Error(data?.error || 'agent-flag-toggle failed');
    err.code = data?.code;
    throw err;
  }
  // Surface but don't fail on audit-write hiccups — the toggle
  // landed correctly. The hook decides how to render.
  return {
    newValue:    data.new_value,
    auditId:     data.audit_id,
    auditFailed: !!data.audit_failed,
  };
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
// shadow_mode, read_only_mode, slug, identity, triggers) are never touched.
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
//   live      — all three flags false (normal operation)
//   dormant   — kill_switch=true (return-immediately, no Claude call)
//   read_only — read_only_mode=true (Claude runs, all tool calls suppressed)
//   shadow    — shadow_mode=true (loop runs but confirm-tier writes routed
//               to ai_suggestions instead of executing)
//
// Precedence is the same as the runtime: kill > read_only > shadow.
export function agentStatus(agent) {
  if (!agent) return 'unknown';
  if (agent.kill_switch) return 'dormant';
  if (agent.read_only_mode) return 'read_only';
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
