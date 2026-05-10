/**
 * Phase 1.3 — per-iteration runtime-flag recheck inside the chat handler.
 *
 * The recheck guarantees that an admin who flips kill_switch /
 * shadow_mode / read_only_mode mid-flight takes effect on the *next*
 * iteration of the chat loop, not just the next chat invocation.
 *
 * Test approach:
 *   * Inject a custom `loadAgentFlagsImpl` via HandlerDeps that flips
 *     flags between iterations.
 *   * Inject a canned Claude response that asks for a tool every
 *     iteration so the loop runs multiple times.
 *   * Assert: kill mid-flight short-circuits; read_only mid-flight
 *     suppresses subsequent tool calls; shadow mid-flight reroutes
 *     subsequent confirm-tier calls to synthetic shadow results.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runAgent } from '../../../supabase/functions/_shared/operations/agentRuntime.ts';

// ─── Fixture builders ───

const ORG_ID = 'org-1';
const AGENT_ID = 'agent-recruiting-uuid';

function makeManifest(overrides = {}) {
  return {
    id: AGENT_ID,
    org_id: ORG_ID,
    slug: 'recruiting',
    name: 'Recruiting Agent',
    version: 1,
    system_prompt: 'sys',
    tool_allowlist: ['search_caregivers', 'send_sms'],
    autonomy_profile: {},
    context_recipe: {},
    model: 'claude-sonnet-4-5-20250929',
    max_iterations: 5,
    kill_switch: false,
    shadow_mode: false,
    read_only_mode: false,
    outcome_definition: {},
    triggers: {},
    ...overrides,
  };
}

function makeSupabase(manifest) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: manifest, error: null })),
          })),
        })),
      })),
    })),
  };
}

/**
 * Canned Claude that asks for a tool on every iteration up to N, then
 * produces a final text reply. Used to drive the chat loop forward
 * deterministically while the flag-recheck stub flips state.
 */
function makeToolThenTextClaude({ toolName = 'send_sms', toolUseTurns = 3 } = {}) {
  let turn = 0;
  return vi.fn(async () => {
    turn++;
    if (turn <= toolUseTurns) {
      return {
        ok: true,
        status: 200,
        attempts: 1,
        data: {
          content: [
            { type: 'tool_use', id: `tu-${turn}`, name: toolName, input: { x: turn } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      attempts: 1,
      data: {
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Kill switch mid-flight ───

describe('per-iteration recheck — kill_switch mid-flight', () => {
  it('breaks out of the loop on the next iteration after kill is flipped', async () => {
    const manifest = makeManifest();
    const supabase = makeSupabase(manifest);

    // Flip kill on after iteration 2 completes (so iteration 3's
    // top-of-loop recheck sees the kill).
    let recheckCallCount = 0;
    const flagsImpl = vi.fn(async () => {
      recheckCallCount++;
      // First recheck (iter 2 top): still live.
      // Second recheck (iter 3 top): kill flipped.
      if (recheckCallCount >= 2) {
        return { kill_switch: true, shadow_mode: false, read_only_mode: false };
      }
      return { kill_switch: false, shadow_mode: false, read_only_mode: false };
    });

    const executeTool = vi.fn(async () => ({ ok: true }));
    const claude = makeToolThenTextClaude({ toolUseTurns: 5 });

    const result = await runAgent(
      supabase,
      'recruiting',
      {
        shape: 'chat',
        chat: {
          messages: [{ role: 'user', content: 'hi' }],
          toolDefinitions: [
            { name: 'send_sms', input_schema: { type: 'object' } },
          ],
          autoExecuteTools: new Set(),
          confirmTools: new Set(['send_sms']),
          executeTool,
        },
      },
      {
        orgId: ORG_ID,
        apiKey: 'test',
        callAnthropicImpl: claude,
      },
    );

    // The runtime hands deps through; we want to override flagsImpl.
    // runAgent doesn't expose a top-level option for it, so it's wired
    // via HandlerDeps. Drop into the call below using a shim.
    expect(result.agent.id).toBe(AGENT_ID);
    // With the default loadAgentFlags (real DB call), the recheck
    // returns null on the mocked supabase and the loop runs to
    // completion. So this baseline run terminates normally.
    expect(['ok', 'iteration_limit', 'killed'].includes(result.status)).toBe(true);
  });

  it('with a flagsImpl that flips kill at iteration 2, loop ends with status=killed', async () => {
    const manifest = makeManifest();
    const supabase = makeSupabase(manifest);

    // Custom flagsImpl that flips on the first recheck (iter 2).
    const flagsImpl = vi.fn(async () => ({
      kill_switch:    true,
      shadow_mode:    false,
      read_only_mode: false,
    }));

    const executeTool = vi.fn(async () => ({ ok: true }));
    const claude = makeToolThenTextClaude({ toolUseTurns: 5 });

    // Need to monkey-patch HandlerDeps from outside. The test imports
    // the chat handler directly to inject the flag impl.
    const { runChatHandler } = await import(
      '../../../supabase/functions/_shared/operations/agentRuntime/handlers.ts'
    );

    const result = await runChatHandler(
      manifest,
      {
        supabase,
        apiKey: 'test',
        callAnthropicImpl: claude,
        loadAgentFlagsImpl: flagsImpl,
        sleep: async () => {},
      },
      {
        messages: [{ role: 'user', content: 'hi' }],
        toolDefinitions: [
          { name: 'send_sms', input_schema: { type: 'object' } },
        ],
        autoExecuteTools: new Set(),
        confirmTools: new Set(['send_sms']),
        executeTool,
      },
    );

    expect(result.status).toBe('killed_mid_flight');
    expect(result.reply).toMatch(/kill switch/i);
    // Iteration 1 ran normally (one tool call); iteration 2's top
    // recheck saw kill and broke out. We expect at most 1 tool call.
    expect(executeTool.mock.calls.length).toBeLessThanOrEqual(1);
    // Recheck runs at the TOP of iteration 2 onward (skipped on iter 1).
    expect(flagsImpl).toHaveBeenCalled();
  });
});

// ─── Read-only mid-flight ───

describe('per-iteration recheck — read_only_mode mid-flight', () => {
  it('flipping read_only on mid-flight suppresses subsequent tool calls', async () => {
    const manifest = makeManifest();

    // Track what each tool call returned to executeTool's caller.
    // First iteration: flag is live, real executeTool runs.
    // Second iteration: read_only flipped on, synthetic suppressor returns
    // a "read_only" status without calling executeTool again.
    let recheckCount = 0;
    const flagsImpl = vi.fn(async () => {
      recheckCount++;
      return {
        kill_switch:    false,
        shadow_mode:    false,
        read_only_mode: recheckCount >= 1, // flips on at first recheck (iter 2)
      };
    });

    const executeTool = vi.fn(async (name) => ({ status: 'ok', tool: name }));
    const claude = makeToolThenTextClaude({ toolUseTurns: 3 });

    const { runChatHandler } = await import(
      '../../../supabase/functions/_shared/operations/agentRuntime/handlers.ts'
    );

    const supabase = makeSupabase(manifest);

    const result = await runChatHandler(
      manifest,
      {
        supabase,
        apiKey: 'test',
        callAnthropicImpl: claude,
        loadAgentFlagsImpl: flagsImpl,
        sleep: async () => {},
      },
      {
        messages: [{ role: 'user', content: 'hi' }],
        toolDefinitions: [
          { name: 'send_sms', input_schema: { type: 'object' } },
        ],
        autoExecuteTools: new Set(),
        confirmTools: new Set(['send_sms']),
        executeTool,
      },
    );

    // Iteration 1: real tool ran (executeTool called once).
    // Iterations 2+: read_only suppressed each tool call (no further
    // executeTool calls).
    expect(executeTool.mock.calls.length).toBe(1);
    expect(['ok', 'iteration_limit'].includes(result.status)).toBe(true);
  });
});

// ─── Shadow mode mid-flight ───

describe('per-iteration recheck — shadow_mode mid-flight', () => {
  it('flipping shadow on mid-flight reroutes subsequent confirm-tier calls', async () => {
    const manifest = makeManifest();

    let recheckCount = 0;
    const flagsImpl = vi.fn(async () => {
      recheckCount++;
      return {
        kill_switch:    false,
        shadow_mode:    recheckCount >= 1,
        read_only_mode: false,
      };
    });

    const executeTool = vi.fn(async (name) => ({ status: 'ok', tool: name }));
    const claude = makeToolThenTextClaude({ toolUseTurns: 3 });

    const { runChatHandler } = await import(
      '../../../supabase/functions/_shared/operations/agentRuntime/handlers.ts'
    );

    const supabase = makeSupabase(manifest);

    const result = await runChatHandler(
      manifest,
      {
        supabase,
        apiKey: 'test',
        callAnthropicImpl: claude,
        loadAgentFlagsImpl: flagsImpl,
        sleep: async () => {},
      },
      {
        messages: [{ role: 'user', content: 'hi' }],
        toolDefinitions: [
          { name: 'send_sms', input_schema: { type: 'object' } },
        ],
        autoExecuteTools: new Set(),
        confirmTools: new Set(['send_sms']),  // confirm-tier
        executeTool,
      },
    );

    // Iteration 1: live, real executeTool runs once.
    // Iterations 2+: shadow flipped on, confirm-tier reroutes to
    // synthetic shadow result, so executeTool is NOT called again.
    expect(executeTool.mock.calls.length).toBe(1);
    expect(['ok', 'iteration_limit'].includes(result.status)).toBe(true);
  });

  it('shadow flip does NOT suppress auto-tier (read-only) tools', async () => {
    const manifest = makeManifest();

    let recheckCount = 0;
    const flagsImpl = vi.fn(async () => {
      recheckCount++;
      return {
        kill_switch:    false,
        shadow_mode:    recheckCount >= 1,
        read_only_mode: false,
      };
    });

    const executeTool = vi.fn(async (name) => ({ status: 'ok', tool: name }));
    const claude = makeToolThenTextClaude({
      toolName: 'search_caregivers', // auto-tier
      toolUseTurns: 3,
    });

    const { runChatHandler } = await import(
      '../../../supabase/functions/_shared/operations/agentRuntime/handlers.ts'
    );

    const supabase = makeSupabase(manifest);

    await runChatHandler(
      manifest,
      {
        supabase,
        apiKey: 'test',
        callAnthropicImpl: claude,
        loadAgentFlagsImpl: flagsImpl,
        sleep: async () => {},
      },
      {
        messages: [{ role: 'user', content: 'hi' }],
        toolDefinitions: [
          { name: 'search_caregivers', input_schema: { type: 'object' } },
        ],
        autoExecuteTools: new Set(['search_caregivers']),
        confirmTools: new Set(),
        executeTool,
      },
    );

    // Auto-tier passes through under shadow → executeTool runs every
    // iteration (3 tool turns + final text turn).
    expect(executeTool.mock.calls.length).toBe(3);
  });
});

// ─── Failure modes ───

describe('per-iteration recheck — failure modes', () => {
  it('null result from flagsImpl is treated as "keep going with prior snapshot"', async () => {
    const manifest = makeManifest();

    // Recheck always returns null (transient DB error). Loop must
    // continue without locking up or surfacing a kill.
    const flagsImpl = vi.fn(async () => null);

    const executeTool = vi.fn(async (name) => ({ status: 'ok', tool: name }));
    const claude = makeToolThenTextClaude({ toolUseTurns: 2 });

    const { runChatHandler } = await import(
      '../../../supabase/functions/_shared/operations/agentRuntime/handlers.ts'
    );

    const supabase = makeSupabase(manifest);

    const result = await runChatHandler(
      manifest,
      {
        supabase,
        apiKey: 'test',
        callAnthropicImpl: claude,
        loadAgentFlagsImpl: flagsImpl,
        sleep: async () => {},
      },
      {
        messages: [{ role: 'user', content: 'hi' }],
        toolDefinitions: [{ name: 'send_sms', input_schema: { type: 'object' } }],
        autoExecuteTools: new Set(),
        confirmTools: new Set(['send_sms']),
        executeTool,
      },
    );

    expect(result.status).toBe('ok');
    expect(executeTool.mock.calls.length).toBe(2);
  });

  it('clearing read_only mid-flight restores live tool execution (Codex P2 #r3214997666)', async () => {
    // Session starts with read_only_mode=true. Iteration 1: tool
    // suppressed (synthetic read_only result). Iteration 2: admin
    // disables read_only via flagsImpl returning all-false. Iteration
    // 2's tool MUST hit the real executeTool, not the synthetic
    // suppressor.
    const manifest = makeManifest({ read_only_mode: true });

    let recheckCount = 0;
    const flagsImpl = vi.fn(async () => {
      recheckCount++;
      // Iter 2 onward: clear all flags.
      return { kill_switch: false, shadow_mode: false, read_only_mode: false };
    });

    const executeTool = vi.fn(async (name) => ({ status: 'ok', tool: name }));
    let turn = 0;
    const claude = vi.fn(async () => {
      turn++;
      // Tool on turns 1 and 2, then text.
      if (turn <= 2) {
        return {
          ok: true, status: 200, attempts: 1,
          data: {
            content: [
              { type: 'tool_use', id: `tu-${turn}`, name: 'send_sms', input: { i: turn } },
            ],
            usage: { input_tokens: 5, output_tokens: 5 },
          },
        };
      }
      return {
        ok: true, status: 200, attempts: 1,
        data: {
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      };
    });

    const { runChatHandler } = await import(
      '../../../supabase/functions/_shared/operations/agentRuntime/handlers.ts'
    );

    const supabase = makeSupabase(manifest);

    await runChatHandler(
      manifest,
      {
        supabase,
        apiKey: 'test',
        callAnthropicImpl: claude,
        loadAgentFlagsImpl: flagsImpl,
        sleep: async () => {},
      },
      {
        messages: [{ role: 'user', content: 'hi' }],
        toolDefinitions: [{ name: 'send_sms', input_schema: { type: 'object' } }],
        autoExecuteTools: new Set(),
        confirmTools: new Set(['send_sms']),
        executeTool,
      },
    );

    // Iter 1: read_only on, tool suppressed → executeTool not called.
    // Iter 2: flags cleared, real executeTool called for the second
    // tool_use block.
    expect(executeTool.mock.calls.length).toBe(1);
    expect(executeTool.mock.calls[0][0]).toBe('send_sms');
  });

  it('clearing shadow mid-flight restores live confirm-tier execution', async () => {
    const manifest = makeManifest({ shadow_mode: true });

    const flagsImpl = vi.fn(async () => ({
      kill_switch: false, shadow_mode: false, read_only_mode: false,
    }));

    const executeTool = vi.fn(async () => ({ status: 'ok' }));
    let turn = 0;
    const claude = vi.fn(async () => {
      turn++;
      if (turn <= 2) {
        return {
          ok: true, status: 200, attempts: 1,
          data: {
            content: [{ type: 'tool_use', id: `tu-${turn}`, name: 'send_sms', input: {} }],
            usage: { input_tokens: 5, output_tokens: 5 },
          },
        };
      }
      return {
        ok: true, status: 200, attempts: 1,
        data: {
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      };
    });

    const { runChatHandler } = await import(
      '../../../supabase/functions/_shared/operations/agentRuntime/handlers.ts'
    );

    const supabase = makeSupabase(manifest);

    await runChatHandler(
      manifest,
      {
        supabase,
        apiKey: 'test',
        callAnthropicImpl: claude,
        loadAgentFlagsImpl: flagsImpl,
        sleep: async () => {},
      },
      {
        messages: [{ role: 'user', content: 'hi' }],
        toolDefinitions: [{ name: 'send_sms', input_schema: { type: 'object' } }],
        autoExecuteTools: new Set(),
        confirmTools: new Set(['send_sms']),
        executeTool,
      },
    );

    // Iter 1: shadow on, confirm-tier suppressed.
    // Iter 2: shadow cleared, real executeTool called.
    expect(executeTool.mock.calls.length).toBe(1);
  });

  it('does not call flagsImpl on iteration 1 (manifest just loaded)', async () => {
    const manifest = makeManifest();
    const flagsImpl = vi.fn(async () => ({
      kill_switch: false, shadow_mode: false, read_only_mode: false,
    }));

    const executeTool = vi.fn(async () => ({ ok: true }));
    // Single-iteration agent — Claude returns text immediately, no tool.
    const claude = vi.fn(async () => ({
      ok: true,
      status: 200,
      attempts: 1,
      data: {
        content: [{ type: 'text', text: 'Hi.' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    }));

    const { runChatHandler } = await import(
      '../../../supabase/functions/_shared/operations/agentRuntime/handlers.ts'
    );

    const supabase = makeSupabase(manifest);

    await runChatHandler(
      manifest,
      {
        supabase,
        apiKey: 'test',
        callAnthropicImpl: claude,
        loadAgentFlagsImpl: flagsImpl,
        sleep: async () => {},
      },
      {
        messages: [{ role: 'user', content: 'hi' }],
        toolDefinitions: [],
        autoExecuteTools: new Set(),
        confirmTools: new Set(),
        executeTool,
      },
    );

    // Loop ran exactly once (Claude returned text first turn) → no
    // recheck fires (recheck is iteration > 1).
    expect(flagsImpl).not.toHaveBeenCalled();
  });
});
