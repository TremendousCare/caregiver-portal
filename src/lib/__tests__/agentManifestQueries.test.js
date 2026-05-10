// Phase 0.5 PR A — unit tests for the agent-manifest query helpers.
// Tests the supabase chain shape + RPC call wiring + display helpers.
// No real network — supabase is fully mocked.

import { describe, it, expect, vi } from 'vitest';
import {
  loadAgents,
  loadAgentVersions,
  toggleAgentFlag,
  updateAgentManifest,
  revertAgentToVersion,
  isVersionConflict,
  summariseAgent,
  agentStatus,
} from '../../components/agentManifest/queries';

function makeChain({ data = null, error = null }) {
  // Mimics the supabase fluent chain: from(...).select(...).order(...) etc.
  // The terminal awaitable resolves with { data, error }.
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    then: (resolve) => Promise.resolve(resolve({ data, error })),
  };
  return chain;
}

function makeSupabase({ tableMocks = {}, rpcMock, invokeMock } = {}) {
  return {
    from: vi.fn((table) => tableMocks[table] || makeChain({ data: [] })),
    rpc: rpcMock || vi.fn(),
    functions: {
      invoke: invokeMock || vi.fn(),
    },
  };
}

describe('loadAgents', () => {
  it('queries agents table and returns rows ordered by slug', async () => {
    const fakeRows = [
      { id: '1', slug: 'inbound_router', name: 'A' },
      { id: '2', slug: 'recruiting',     name: 'B' },
    ];
    const chain = makeChain({ data: fakeRows });
    const sb = makeSupabase({ tableMocks: { agents: chain } });

    const result = await loadAgents(sb);

    expect(sb.from).toHaveBeenCalledWith('agents');
    expect(chain.select).toHaveBeenCalled();
    expect(chain.order).toHaveBeenCalledWith('slug', { ascending: true });
    expect(result).toEqual(fakeRows);
  });

  it('returns [] when supabase returns null data', async () => {
    const chain = makeChain({ data: null });
    const sb = makeSupabase({ tableMocks: { agents: chain } });
    const result = await loadAgents(sb);
    expect(result).toEqual([]);
  });

  it('throws when supabase returns an error', async () => {
    const chain = makeChain({ error: { message: 'boom' } });
    const sb = makeSupabase({ tableMocks: { agents: chain } });
    await expect(loadAgents(sb)).rejects.toMatchObject({ message: 'boom' });
  });
});

describe('loadAgentVersions', () => {
  it('returns [] without hitting supabase when agentId is missing', async () => {
    const sb = makeSupabase();
    const result = await loadAgentVersions(sb, null);
    expect(result).toEqual([]);
    expect(sb.from).not.toHaveBeenCalled();
  });

  it('queries agent_versions filtered by agent_id, newest first', async () => {
    const rows = [
      { id: 'v2', version: 2 },
      { id: 'v1', version: 1 },
    ];
    const chain = makeChain({ data: rows });
    const sb = makeSupabase({ tableMocks: { agent_versions: chain } });

    const result = await loadAgentVersions(sb, 'agent-uuid');

    expect(sb.from).toHaveBeenCalledWith('agent_versions');
    expect(chain.eq).toHaveBeenCalledWith('agent_id', 'agent-uuid');
    expect(chain.order).toHaveBeenCalledWith('version', { ascending: false });
    expect(result).toEqual(rows);
  });
});

describe('toggleAgentFlag (Phase 1.1.B: routes through agent-flag-toggle edge function)', () => {
  it('rejects without agentId', async () => {
    const sb = makeSupabase();
    await expect(toggleAgentFlag(sb, { agentId: null, flag: 'kill_switch', value: true }))
      .rejects.toThrow(/agentId required/);
  });

  it('rejects unknown flag names (defense in depth — edge function also validates)', async () => {
    const sb = makeSupabase();
    await expect(toggleAgentFlag(sb, { agentId: 'a', flag: 'evil_mode', value: true }))
      .rejects.toThrow(/invalid flag/);
  });

  it('accepts read_only_mode (Phase 1.3) alongside kill_switch and shadow_mode', async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      data: { success: true, new_value: true, audit_failed: false },
      error: null,
    });
    const sb = makeSupabase({ invokeMock });

    const result = await toggleAgentFlag(sb, {
      agentId: 'agent-uuid',
      flag: 'read_only_mode',
      value: true,
    });

    expect(invokeMock).toHaveBeenCalledWith('agent-flag-toggle', {
      body: { agent_id: 'agent-uuid', flag: 'read_only_mode', value: true },
    });
    expect(result.newValue).toBe(true);
  });

  it('invokes agent-flag-toggle edge function with the right body', async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      data: { success: true, new_value: true, audit_id: 'aa-1', audit_failed: false },
      error: null,
    });
    const sb = makeSupabase({ invokeMock });

    const result = await toggleAgentFlag(sb, {
      agentId: 'agent-uuid',
      flag: 'kill_switch',
      value: true,
    });

    expect(invokeMock).toHaveBeenCalledWith('agent-flag-toggle', {
      body: { agent_id: 'agent-uuid', flag: 'kill_switch', value: true },
    });
    expect(result).toEqual({ newValue: true, auditId: 'aa-1', auditFailed: false });
  });

  it('coerces truthy/falsy value to strict boolean before invoke', async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      data: { success: true, new_value: false, audit_failed: false },
      error: null,
    });
    const sb = makeSupabase({ invokeMock });

    await toggleAgentFlag(sb, {
      agentId: 'agent-uuid',
      flag: 'shadow_mode',
      value: 0, // falsy non-bool
    });

    const body = invokeMock.mock.calls[0][1].body;
    expect(body.value).toBe(false);
    expect(typeof body.value).toBe('boolean');
  });

  it('propagates errors from supabase.functions.invoke', async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'invoke failed', code: 'NETWORK' },
    });
    const sb = makeSupabase({ invokeMock });

    await expect(
      toggleAgentFlag(sb, { agentId: 'a', flag: 'kill_switch', value: true })
    ).rejects.toMatchObject({ message: 'invoke failed' });
  });

  it('propagates app-level error responses (success=false from edge function)', async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      data: { error: 'permission denied: not an admin', code: '42501' },
      error: null,
    });
    const sb = makeSupabase({ invokeMock });

    await expect(
      toggleAgentFlag(sb, { agentId: 'a', flag: 'kill_switch', value: true })
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('returns audit_failed=true when edge function says toggle landed but audit row failed', async () => {
    // This is the "chain has a gap" case the verifier will catch later.
    const invokeMock = vi.fn().mockResolvedValue({
      data: { success: true, new_value: true, audit_failed: true },
      error: null,
    });
    const sb = makeSupabase({ invokeMock });

    const result = await toggleAgentFlag(sb, {
      agentId: 'a', flag: 'kill_switch', value: true,
    });
    expect(result.auditFailed).toBe(true);
    expect(result.newValue).toBe(true);
  });
});

describe('updateAgentManifest', () => {
  const okArgs = {
    agentId: 'a1',
    expectedVersion: 1,
    updates: { name: 'X' },
    changeSummary: 'Tweak name',
  };

  it('rejects without agentId', async () => {
    const sb = makeSupabase();
    await expect(updateAgentManifest(sb, { ...okArgs, agentId: null }))
      .rejects.toThrow(/agentId required/);
  });

  it('rejects non-integer expectedVersion', async () => {
    const sb = makeSupabase();
    await expect(updateAgentManifest(sb, { ...okArgs, expectedVersion: 0 }))
      .rejects.toThrow(/positive integer/);
    await expect(updateAgentManifest(sb, { ...okArgs, expectedVersion: 1.5 }))
      .rejects.toThrow(/positive integer/);
  });

  it('rejects empty changeSummary', async () => {
    const sb = makeSupabase();
    await expect(updateAgentManifest(sb, { ...okArgs, changeSummary: '   ' }))
      .rejects.toThrow(/changeSummary required/);
  });

  it('calls update_agent_manifest_v1 RPC with correct args + trims summary', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: 2, error: null });
    const sb = makeSupabase({ rpcMock });

    const result = await updateAgentManifest(sb, {
      ...okArgs,
      changeSummary: '  My change  ',
    });

    expect(rpcMock).toHaveBeenCalledWith('update_agent_manifest_v1', {
      p_agent_id:         'a1',
      p_expected_version: 1,
      p_updates:          { name: 'X' },
      p_change_summary:   'My change',
    });
    expect(result).toBe(2);
  });

  it('propagates RPC errors (admin gate, version conflict)', async () => {
    const rpcMock = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'agent_version_conflict: ...', code: 'P0001' },
    });
    const sb = makeSupabase({ rpcMock });
    await expect(updateAgentManifest(sb, okArgs)).rejects.toMatchObject({ code: 'P0001' });
  });
});

describe('revertAgentToVersion', () => {
  const okArgs = { agentId: 'a1', targetVersion: 1, changeSummary: 'Revert to v1' };

  it('rejects without agentId', async () => {
    const sb = makeSupabase();
    await expect(revertAgentToVersion(sb, { ...okArgs, agentId: null }))
      .rejects.toThrow(/agentId required/);
  });

  it('rejects bad targetVersion', async () => {
    const sb = makeSupabase();
    await expect(revertAgentToVersion(sb, { ...okArgs, targetVersion: 0 }))
      .rejects.toThrow(/positive integer/);
  });

  it('rejects empty changeSummary', async () => {
    const sb = makeSupabase();
    await expect(revertAgentToVersion(sb, { ...okArgs, changeSummary: '' }))
      .rejects.toThrow(/changeSummary required/);
  });

  it('calls revert_agent_to_version_v1 RPC with correct args', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: 4, error: null });
    const sb = makeSupabase({ rpcMock });

    const result = await revertAgentToVersion(sb, okArgs);

    expect(rpcMock).toHaveBeenCalledWith('revert_agent_to_version_v1', {
      p_agent_id:       'a1',
      p_target_version: 1,
      p_change_summary: 'Revert to v1',
    });
    expect(result).toBe(4);
  });

  it('propagates RPC errors (no-op revert blocked, etc.)', async () => {
    const rpcMock = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'no-op revert blocked', code: '22023' },
    });
    const sb = makeSupabase({ rpcMock });
    await expect(revertAgentToVersion(sb, okArgs)).rejects.toMatchObject({ code: '22023' });
  });
});

describe('isVersionConflict', () => {
  it('detects by sqlstate P0001', () => {
    expect(isVersionConflict({ code: 'P0001' })).toBe(true);
  });
  it('detects by message substring (defense in depth)', () => {
    expect(isVersionConflict({ message: 'agent_version_conflict: expected ...' })).toBe(true);
  });
  it('returns false for other errors', () => {
    expect(isVersionConflict({ code: '42501' })).toBe(false);
    expect(isVersionConflict({ message: 'some other error' })).toBe(false);
    expect(isVersionConflict(null)).toBe(false);
    expect(isVersionConflict(undefined)).toBe(false);
  });
});

describe('summariseAgent', () => {
  it('returns empty string for nullish agent', () => {
    expect(summariseAgent(null)).toBe('');
    expect(summariseAgent(undefined)).toBe('');
  });

  it('shortens common Claude model names', () => {
    const out = summariseAgent({
      slug: 'recruiting',
      tool_allowlist: new Array(40).fill('x'),
      model: 'claude-sonnet-4-5-20250929',
      triggers: {},
    });
    expect(out).toContain('recruiting');
    expect(out).toContain('40 tools');
    expect(out).toContain('sonnet-4.5');
  });

  it('passes the model through unchanged when format is unrecognized', () => {
    const out = summariseAgent({
      slug: 'x', tool_allowlist: [], model: 'gpt-4o', triggers: {},
    });
    expect(out).toContain('gpt-4o');
  });

  it('includes cron schedule when present', () => {
    const out = summariseAgent({
      slug: 'proactive_planner',
      tool_allowlist: new Array(10).fill('x'),
      model: 'claude-sonnet-4-5-20250929',
      triggers: { cron: '0 14 * * *' },
    });
    expect(out).toContain('cron 0 14 * * *');
  });
});

describe('agentStatus', () => {
  it('returns "live" for all flags false', () => {
    expect(agentStatus({
      kill_switch: false, shadow_mode: false, read_only_mode: false,
    })).toBe('live');
  });

  it('returns "dormant" when kill_switch is true (regardless of other flags)', () => {
    expect(agentStatus({ kill_switch: true,  shadow_mode: false, read_only_mode: false })).toBe('dormant');
    expect(agentStatus({ kill_switch: true,  shadow_mode: true,  read_only_mode: false })).toBe('dormant');
    expect(agentStatus({ kill_switch: true,  shadow_mode: false, read_only_mode: true  })).toBe('dormant');
    expect(agentStatus({ kill_switch: true,  shadow_mode: true,  read_only_mode: true  })).toBe('dormant');
  });

  it('returns "read_only" when read_only_mode=true and kill_switch=false (precedence over shadow)', () => {
    // Phase 1.3: read_only > shadow because read_only is strictly more
    // restrictive (suppresses all tool calls; shadow only confirms-tier).
    expect(agentStatus({ kill_switch: false, shadow_mode: false, read_only_mode: true })).toBe('read_only');
    expect(agentStatus({ kill_switch: false, shadow_mode: true,  read_only_mode: true })).toBe('read_only');
  });

  it('returns "shadow" when shadow_mode=true and other flags false', () => {
    expect(agentStatus({ kill_switch: false, shadow_mode: true, read_only_mode: false })).toBe('shadow');
  });

  it('returns "unknown" for null', () => {
    expect(agentStatus(null)).toBe('unknown');
  });
});
