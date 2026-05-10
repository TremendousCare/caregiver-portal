/**
 * Agent Platform Phase 0.3 — agentRuntime unit tests (Layer A).
 *
 * These tests exercise `runAgent` and its three internal handlers with a
 * mocked Anthropic call and a mocked supabase client. They verify the
 * behaviour the runtime promises (manifest dispatch, kill-switch handling,
 * tool allowlist filtering, agentic loop, shadow mode, cost telemetry,
 * error paths) without ever reaching the network or a real database.
 *
 * Layer B (`agentRuntimeParity.test.js`) handles byte-equal parity with
 * legacy edge functions via fixtures. Layer C (`agentRuntimeLive.test.js`)
 * is gated against the real Anthropic API.
 *
 * See docs/AGENT_PLATFORM.md → Phase 0.3 for the full strategy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  runAgent,
  AgentNotFoundError,
  MissingOrgIdError,
  isToolAllowed,
  levelForAction,
  recipeLayers,
} from '../../../supabase/functions/_shared/operations/agentRuntime.ts';
import {
  loadManifest,
} from '../../../supabase/functions/_shared/operations/agentRuntime/manifest.ts';
import {
  runChatHandler,
  runPlannerHandler,
  runRouterHandler,
  ROUTER_DEFAULT_INTENTS,
  ROUTER_DEFAULT_ACTIONS,
} from '../../../supabase/functions/_shared/operations/agentRuntime/handlers.ts';
import {
  callAnthropic,
} from '../../../supabase/functions/_shared/operations/agentRuntime/anthropic.ts';

// ─── Test fixtures (manifests) ───

function recruitingManifest(overrides = {}) {
  return {
    id: 'agent-recruiting-uuid',
    org_id: 'tc-org',
    slug: 'recruiting',
    name: 'Recruiting Agent',
    version: 1,
    system_prompt: 'You are the Tremendous Care recruiter.',
    tool_allowlist: [
      'search_caregivers',
      'get_caregiver_detail',
      'add_note',
      'send_sms',
      'create_calendar_event',
    ],
    autonomy_profile: {
      search_caregivers: { current_level: 'L4' },
      get_caregiver_detail: { current_level: 'L4' },
      add_note: { current_level: 'L4' },
      send_sms: { current_level: 'L2' },
      create_calendar_event: { current_level: 'L2' },
    },
    context_recipe: {
      layers: ['identity', 'situational', 'memories', 'threads', 'viewing', 'guidelines'],
      pipeline_scope: 'caregivers_and_clients',
    },
    model: 'claude-sonnet-4-5-20250929',
    max_iterations: 5,
    kill_switch: false,
    shadow_mode: false,
    read_only_mode: false,
    outcome_definition: {},
    triggers: { invocation_modes: ['chat', 'briefing', 'confirmed_action'] },
    ...overrides,
  };
}

function plannerManifest(overrides = {}) {
  return {
    id: 'agent-planner-uuid',
    org_id: 'tc-org',
    slug: 'proactive_planner',
    name: 'Proactive Planner',
    version: 1,
    system_prompt: 'You are the daily planner.',
    tool_allowlist: ['send_sms', 'send_email', 'add_note'],
    autonomy_profile: {
      send_sms: { current_level: 'L1' },
      add_note: { current_level: 'L4' },
    },
    context_recipe: { layers: ['identity', 'situational', 'memories'] },
    model: 'claude-sonnet-4-5-20250929',
    max_iterations: 1,
    kill_switch: false,
    shadow_mode: false,
    read_only_mode: false,
    outcome_definition: {},
    triggers: { invocation_modes: ['cron_daily', 'event_triggered'] },
    ...overrides,
  };
}

function routerManifest(overrides = {}) {
  return {
    id: 'agent-router-uuid',
    org_id: 'tc-org',
    slug: 'inbound_router',
    name: 'Inbound Message Router',
    version: 1,
    system_prompt: 'You are a message classifier.',
    tool_allowlist: ['send_sms', 'send_email', 'add_note', 'update_phase'],
    autonomy_profile: {
      send_sms: { current_level: 'L2' },
      add_note: { current_level: 'L4' },
    },
    context_recipe: { layers: ['identity', 'memories', 'situational'] },
    model: 'claude-haiku-4-5-20251001',
    max_iterations: 1,
    kill_switch: false,
    shadow_mode: false,
    read_only_mode: false,
    outcome_definition: {},
    triggers: { invocation_modes: ['cron'] },
    ...overrides,
  };
}

// ─── Test fixtures (supabase mock) ───

function makeSupabaseStub(manifest, opts = {}) {
  const fromCalls = [];
  const builder = {
    _filters: [],
    select: vi.fn(function (_cols) {
      return this;
    }),
    eq: vi.fn(function (col, val) {
      this._filters.push([col, val]);
      return this;
    }),
    maybeSingle: vi.fn(async function () {
      if (opts.dbError) {
        return { data: null, error: { message: opts.dbError } };
      }
      if (opts.notFound) {
        return { data: null, error: null };
      }
      return { data: manifest ?? null, error: null };
    }),
  };
  return {
    from: vi.fn((table) => {
      fromCalls.push(table);
      return builder;
    }),
    _calls: { from: fromCalls, builder },
  };
}

// ─── Test fixtures (Claude responses) ───

function claudeTextResponse(text, usage = { input_tokens: 30, output_tokens: 8 }) {
  return {
    ok: true,
    status: 200,
    data: {
      content: [{ type: 'text', text }],
      usage,
    },
    attempts: 1,
  };
}

function claudeToolUseResponse(toolName, input, opts = {}) {
  return {
    ok: true,
    status: 200,
    data: {
      content: [
        ...(opts.precedingText ? [{ type: 'text', text: opts.precedingText }] : []),
        {
          type: 'tool_use',
          id: opts.toolUseId ?? 'toolu_01',
          name: toolName,
          input,
        },
      ],
      usage: opts.usage ?? { input_tokens: 50, output_tokens: 12 },
    },
    attempts: 1,
  };
}

function claudeErrorResponse(status, errorText = 'rate_limited') {
  return { ok: false, status, data: null, errorText, attempts: 1 };
}

function claudeJsonResponse(jsonObj, usage = { input_tokens: 20, output_tokens: 6 }) {
  return {
    ok: true,
    status: 200,
    data: {
      content: [{ type: 'text', text: JSON.stringify(jsonObj) }],
      usage,
    },
    attempts: 1,
  };
}

// ─── manifest module tests ───

describe('manifest — loadManifest', () => {
  it('loads the manifest happy path with org-scoped filters', async () => {
    const m = recruitingManifest();
    const sb = makeSupabaseStub(m);
    const result = await loadManifest(sb, 'recruiting', { orgId: 'tc-org' });
    expect(result).toEqual(m);
    expect(sb.from).toHaveBeenCalledWith('agents');
    expect(sb._calls.builder._filters).toEqual([
      ['slug', 'recruiting'],
      ['org_id', 'tc-org'],
    ]);
  });

  it('throws MissingOrgIdError when orgId is omitted', async () => {
    const sb = makeSupabaseStub(recruitingManifest());
    await expect(loadManifest(sb, 'recruiting')).rejects.toBeInstanceOf(
      MissingOrgIdError,
    );
  });

  it('throws MissingOrgIdError when orgId is empty string', async () => {
    const sb = makeSupabaseStub(recruitingManifest());
    await expect(
      loadManifest(sb, 'recruiting', { orgId: '' }),
    ).rejects.toBeInstanceOf(MissingOrgIdError);
  });

  it('does not query the DB when orgId is missing (fail-fast)', async () => {
    const sb = makeSupabaseStub(recruitingManifest());
    await loadManifest(sb, 'recruiting', { orgId: 'tc-org' }).catch(() => {});
    sb.from.mockClear();
    await expect(loadManifest(sb, 'recruiting')).rejects.toBeInstanceOf(
      MissingOrgIdError,
    );
    expect(sb.from).not.toHaveBeenCalled();
  });

  it('throws AgentNotFoundError when the row is absent', async () => {
    const sb = makeSupabaseStub(null, { notFound: true });
    await expect(
      loadManifest(sb, 'mystery_agent', { orgId: 'tc-org' }),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it('throws a generic Error on transport failure', async () => {
    const sb = makeSupabaseStub(null, { dbError: 'connection refused' });
    await expect(
      loadManifest(sb, 'recruiting', { orgId: 'tc-org' }),
    ).rejects.toThrow(/Manifest load failed/);
  });
});

describe('manifest — derived helpers', () => {
  it('levelForAction returns the manifest-configured level', () => {
    const m = recruitingManifest();
    expect(levelForAction(m, 'send_sms')).toBe('L2');
    expect(levelForAction(m, 'search_caregivers')).toBe('L4');
  });

  it('levelForAction defaults to L2 for unknown actions', () => {
    const m = recruitingManifest();
    expect(levelForAction(m, 'mystery_action')).toBe('L2');
  });

  it('isToolAllowed reflects the allowlist', () => {
    const m = recruitingManifest();
    expect(isToolAllowed(m, 'send_sms')).toBe(true);
    expect(isToolAllowed(m, 'send_docusign_envelope')).toBe(false);
  });

  it('recipeLayers returns the layer list when present', () => {
    const m = recruitingManifest();
    expect(recipeLayers(m)).toEqual([
      'identity',
      'situational',
      'memories',
      'threads',
      'viewing',
      'guidelines',
    ]);
  });

  it('recipeLayers returns null when the recipe omits layers', () => {
    const m = recruitingManifest({ context_recipe: { pipeline_scope: 'x' } });
    expect(recipeLayers(m)).toBeNull();
  });

  it('recipeLayers returns null when layers is malformed (not all strings)', () => {
    const m = recruitingManifest({ context_recipe: { layers: ['a', 42] } });
    expect(recipeLayers(m)).toBeNull();
  });
});

// ─── anthropic helper tests ───

describe('anthropic — callAnthropic', () => {
  function makeFetch(responses) {
    const queue = [...responses];
    return vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error('Unexpected extra fetch call');
      if (next instanceof Error) throw next;
      return next;
    });
  }

  it('returns parsed json on a 200 response', async () => {
    const fetchImpl = makeFetch([
      {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'hi' }] }),
      },
    ]);
    const result = await callAnthropic({
      apiKey: 'k',
      body: {},
      fetchImpl,
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data.content[0].text).toBe('hi');
    expect(result.attempts).toBe(1);
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    const fetchImpl = makeFetch([
      { ok: false, status: 429, text: async () => 'rate limit' },
      {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      },
    ]);
    const result = await callAnthropic({
      apiKey: 'k',
      body: {},
      fetchImpl,
      sleep: async () => {},
      maxRetries: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('retries on 503 and 529 (overloaded)', async () => {
    const fetchImpl = makeFetch([
      { ok: false, status: 503, text: async () => 'unavailable' },
      { ok: false, status: 529, text: async () => 'overloaded' },
      {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      },
    ]);
    const result = await callAnthropic({
      apiKey: 'k',
      body: {},
      fetchImpl,
      sleep: async () => {},
      maxRetries: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('does not retry on a non-retryable 400', async () => {
    const fetchImpl = makeFetch([
      { ok: false, status: 400, text: async () => 'bad request' },
    ]);
    const result = await callAnthropic({
      apiKey: 'k',
      body: {},
      fetchImpl,
      sleep: async () => {},
      maxRetries: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.errorText).toBe('bad request');
    expect(result.attempts).toBe(1);
  });

  it('exhausts retries and returns the last error', async () => {
    const fetchImpl = makeFetch([
      { ok: false, status: 529, text: async () => 'overload 1' },
      { ok: false, status: 529, text: async () => 'overload 2' },
      { ok: false, status: 529, text: async () => 'overload 3' },
    ]);
    const result = await callAnthropic({
      apiKey: 'k',
      body: {},
      fetchImpl,
      sleep: async () => {},
      maxRetries: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(529);
    expect(result.errorText).toBe('overload 3');
    expect(result.attempts).toBe(3);
  });

  it('returns parse_error when the body is not JSON', async () => {
    const fetchImpl = makeFetch([
      {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Unexpected token');
        },
      },
    ]);
    const result = await callAnthropic({
      apiKey: 'k',
      body: {},
      fetchImpl,
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.errorText).toMatch(/parse_error/);
  });

  it('survives a network exception and reports it', async () => {
    const fetchImpl = makeFetch([new Error('ECONNRESET')]);
    const result = await callAnthropic({
      apiKey: 'k',
      body: {},
      fetchImpl,
      sleep: async () => {},
      maxRetries: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.errorText).toBe('ECONNRESET');
  });
});

// ─── runAgent: kill switch + manifest paths ───

describe('runAgent — kill switch', () => {
  it('returns status="killed" and never calls Anthropic', async () => {
    const m = recruitingManifest({ kill_switch: true });
    const sb = makeSupabaseStub(m);
    const callAnthropicImpl = vi.fn();
    const result = await runAgent(
      sb,
      'recruiting',
      {
        shape: 'chat',
        chat: makeMinimalChatRequest(),
      },
      { apiKey: 'test', callAnthropicImpl, orgId: 'tc-org' },
    );
    expect(result.status).toBe('killed');
    expect(result.agent.slug).toBe('recruiting');
    expect(callAnthropicImpl).not.toHaveBeenCalled();
  });

  it('kill switch returns zero cost', async () => {
    const m = recruitingManifest({ kill_switch: true });
    const sb = makeSupabaseStub(m);
    const result = await runAgent(
      sb,
      'recruiting',
      { shape: 'chat', chat: makeMinimalChatRequest() },
      { apiKey: 'k', orgId: 'tc-org' },
    );
    expect(result.cost).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      iterations: 0,
      duration_ms: 0,
    });
  });

  it('kill switch reply is a friendly dormant message', async () => {
    const m = recruitingManifest({ kill_switch: true });
    const sb = makeSupabaseStub(m);
    const result = await runAgent(
      sb,
      'recruiting',
      { shape: 'chat', chat: makeMinimalChatRequest() },
      { apiKey: 'k', orgId: 'tc-org' },
    );
    expect(result.reply).toMatch(/dormant/i);
  });
});

describe('runAgent — manifest errors', () => {
  it('surfaces AgentNotFoundError as status="error" with code', async () => {
    const sb = makeSupabaseStub(null, { notFound: true });
    const result = await runAgent(
      sb,
      'mystery',
      { shape: 'chat', chat: makeMinimalChatRequest() },
      { apiKey: 'k', orgId: 'tc-org' },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('agent_not_found');
    expect(result.agent.slug).toBe('mystery');
  });

  it('surfaces DB transport error as manifest_load_failed', async () => {
    const sb = makeSupabaseStub(null, { dbError: 'timeout' });
    const result = await runAgent(
      sb,
      'recruiting',
      { shape: 'chat', chat: makeMinimalChatRequest() },
      { apiKey: 'k', orgId: 'tc-org' },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('manifest_load_failed');
  });

  it('errors with missing_api_key when no key is provided', async () => {
    const m = recruitingManifest();
    const sb = makeSupabaseStub(m);
    const result = await runAgent(
      sb,
      'recruiting',
      { shape: 'chat', chat: makeMinimalChatRequest() },
      { apiKey: undefined, orgId: 'tc-org' },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('missing_api_key');
  });

  it('errors with missing_org_id when orgId is omitted (fail-fast before manifest load)', async () => {
    const sb = makeSupabaseStub(recruitingManifest());
    const result = await runAgent(
      sb,
      'recruiting',
      { shape: 'chat', chat: makeMinimalChatRequest() },
      { apiKey: 'k' },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('missing_org_id');
    // Defense in depth: no DB call should have happened.
    expect(sb.from).not.toHaveBeenCalled();
  });

  it('errors with missing_org_id when orgId is the empty string', async () => {
    const sb = makeSupabaseStub(recruitingManifest());
    const result = await runAgent(
      sb,
      'recruiting',
      { shape: 'chat', chat: makeMinimalChatRequest() },
      { apiKey: 'k', orgId: '' },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('missing_org_id');
  });
});

describe('runAgent — request shape validation', () => {
  it('rejects a missing shape', async () => {
    const sb = makeSupabaseStub(recruitingManifest());
    const result = await runAgent(sb, 'recruiting', {}, { apiKey: 'k', orgId: 'tc-org' });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('invalid_request');
  });

  it('rejects an unknown shape', async () => {
    const sb = makeSupabaseStub(recruitingManifest());
    const result = await runAgent(
      sb,
      'recruiting',
      { shape: 'mystery_shape' },
      { apiKey: 'k', orgId: 'tc-org' },
    );
    expect(result.status).toBe('error');
  });

  it('rejects when the per-shape payload is missing', async () => {
    const sb = makeSupabaseStub(recruitingManifest());
    const result = await runAgent(
      sb,
      'recruiting',
      { shape: 'chat' },
      { apiKey: 'k', orgId: 'tc-org' },
    );
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/chat payload is required/);
  });
});

// ─── runChatHandler tests ───

function makeMinimalChatRequest(overrides = {}) {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    currentUser: 'TestUser',
    caregivers: [],
    clients: [],
    toolDefinitions: [],
    autoExecuteTools: new Set(),
    confirmTools: new Set(),
    executeTool: async () => ({}),
    ...overrides,
  };
}

describe('runChatHandler — system prompt assembly', () => {
  it('uses the manifest system_prompt as-is when no assembler is supplied', async () => {
    const m = recruitingManifest();
    const callAnthropicImpl = vi.fn(async () => claudeTextResponse('done'));
    const result = await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest(),
    );
    expect(result.status).toBe('ok');
    expect(callAnthropicImpl).toHaveBeenCalled();
    const callBody = callAnthropicImpl.mock.calls[0][0].body;
    expect(callBody.system).toBe(m.system_prompt);
  });

  it('uses the assembled prompt when an assembler is supplied', async () => {
    const m = recruitingManifest();
    const assembler = vi.fn(async () => ({
      prompt: 'ASSEMBLED_PROMPT',
      health: { status: 'healthy', layersLoaded: ['identity'], layersFailed: [], layersTrimmed: [], tokenEstimate: 100 },
    }));
    const callAnthropicImpl = vi.fn(async () => claudeTextResponse('done'));
    const result = await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest({ assembleSystemPrompt: assembler }),
    );
    expect(result.contextHealth?.status).toBe('healthy');
    const callBody = callAnthropicImpl.mock.calls[0][0].body;
    expect(callBody.system).toBe('ASSEMBLED_PROMPT');
    // The assembler was given the recipe layers from the manifest
    expect(assembler.mock.calls[0][0].enabledLayers).toEqual(
      m.context_recipe.layers,
    );
    expect(assembler.mock.calls[0][0].manifestPrompt).toBe(m.system_prompt);
  });

  it('falls back to buildFallbackPrompt when the assembler throws', async () => {
    const m = recruitingManifest();
    const assembler = vi.fn(async () => {
      throw new Error('boom');
    });
    const fallback = vi.fn(() => 'FALLBACK_PROMPT');
    const callAnthropicImpl = vi.fn(async () => claudeTextResponse('done'));
    await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest({
        assembleSystemPrompt: assembler,
        buildFallbackPrompt: fallback,
      }),
    );
    expect(fallback).toHaveBeenCalled();
    const callBody = callAnthropicImpl.mock.calls[0][0].body;
    expect(callBody.system).toBe('FALLBACK_PROMPT');
  });
});

describe('runChatHandler — tool allowlist filtering', () => {
  it('strips tools not in the manifest allowlist before calling Anthropic', async () => {
    const m = recruitingManifest({ tool_allowlist: ['add_note'] });
    const callAnthropicImpl = vi.fn(async () => claudeTextResponse('done'));
    await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest({
        toolDefinitions: [
          { name: 'add_note' },
          { name: 'send_docusign_envelope' },
          { name: 'create_calendar_event' },
        ],
      }),
    );
    const callBody = callAnthropicImpl.mock.calls[0][0].body;
    expect(callBody.tools.map((t) => t.name)).toEqual(['add_note']);
  });

  it('rejects a Claude-suggested tool that is not in the allowlist', async () => {
    const m = recruitingManifest({ tool_allowlist: ['add_note'] });
    // First response: try to call a forbidden tool. Second: end with text.
    const callAnthropicImpl = vi
      .fn()
      .mockResolvedValueOnce(claudeToolUseResponse('send_docusign_envelope', {}))
      .mockResolvedValueOnce(claudeTextResponse('handled'));
    const executeTool = vi.fn(async () => ({}));
    const result = await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest({
        toolDefinitions: [{ name: 'add_note' }],
        executeTool,
      }),
    );
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.status).toBe('ok');
    // The next message in the loop must contain the rejection
    const secondCall = callAnthropicImpl.mock.calls[1][0].body;
    const toolResultBlock = secondCall.messages.at(-1).content[0];
    expect(toolResultBlock.type).toBe('tool_result');
    expect(toolResultBlock.content).toMatch(/not in this agent's allowlist/);
  });
});

describe('runChatHandler — agentic loop', () => {
  it('respects manifest.max_iterations', async () => {
    const m = recruitingManifest({ max_iterations: 2 });
    const callAnthropicImpl = vi
      .fn()
      .mockResolvedValueOnce(claudeToolUseResponse('add_note', { text: 'a' }, { toolUseId: 't1' }))
      .mockResolvedValueOnce(claudeToolUseResponse('add_note', { text: 'b' }, { toolUseId: 't2' }))
      .mockResolvedValueOnce(claudeTextResponse('should not be reached'));
    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest({
        toolDefinitions: [{ name: 'add_note' }],
        autoExecuteTools: new Set(['add_note']),
        executeTool,
      }),
    );
    expect(callAnthropicImpl).toHaveBeenCalledTimes(2);
    expect(result.cost.iterations).toBe(2);
    expect(result.status).toBe('iteration_limit');
  });

  it('returns the final reply when Claude emits text only', async () => {
    const m = recruitingManifest();
    const callAnthropicImpl = vi.fn(async () => claudeTextResponse('hello world'));
    const result = await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest(),
    );
    expect(result.reply).toBe('hello world');
    expect(result.cost.iterations).toBe(1);
  });

  it('routes confirm-tier tools to pendingConfirmation when requires_confirmation', async () => {
    const m = recruitingManifest();
    const callAnthropicImpl = vi
      .fn()
      .mockResolvedValueOnce(claudeToolUseResponse('send_sms', { message: 'hi' }))
      .mockResolvedValueOnce(claudeTextResponse('queued'));
    const executeTool = vi.fn(async () => ({
      requires_confirmation: true,
      summary: 'about to text Sarah',
    }));
    const result = await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest({
        toolDefinitions: [{ name: 'send_sms' }],
        confirmTools: new Set(['send_sms']),
        executeTool,
      }),
    );
    expect(result.pendingConfirmation).toEqual({
      requires_confirmation: true,
      summary: 'about to text Sarah',
    });
  });

  it('records auto-tier tool results in toolResults', async () => {
    const m = recruitingManifest();
    const callAnthropicImpl = vi
      .fn()
      .mockResolvedValueOnce(claudeToolUseResponse('search_caregivers', { q: 'sarah' }))
      .mockResolvedValueOnce(claudeTextResponse('found 2'));
    const executeTool = vi.fn(async () => ({ ok: true, count: 2 }));
    const result = await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest({
        toolDefinitions: [{ name: 'search_caregivers' }],
        autoExecuteTools: new Set(['search_caregivers']),
        executeTool,
      }),
    );
    expect(result.toolResults).toEqual([
      { tool: 'search_caregivers', input: { q: 'sarah' }, result: { ok: true, count: 2 } },
    ]);
  });

  it('aggregates token usage across iterations', async () => {
    const m = recruitingManifest();
    const callAnthropicImpl = vi
      .fn()
      .mockResolvedValueOnce(
        claudeToolUseResponse('add_note', { text: 'a' }, {
          toolUseId: 't1',
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      )
      .mockResolvedValueOnce(
        claudeTextResponse('done', { input_tokens: 110, output_tokens: 5 }),
      );
    const executeTool = vi.fn(async () => ({ ok: true }));
    const result = await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest({
        toolDefinitions: [{ name: 'add_note' }],
        autoExecuteTools: new Set(['add_note']),
        executeTool,
      }),
    );
    expect(result.cost.input_tokens).toBe(210);
    expect(result.cost.output_tokens).toBe(25);
  });

  it('returns a friendly reply on 429 and stops the loop', async () => {
    const m = recruitingManifest();
    const callAnthropicImpl = vi.fn(async () => claudeErrorResponse(429));
    const result = await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest(),
    );
    expect(result.reply).toMatch(/rate-limited/i);
    expect(result.cost.iterations).toBe(1);
  });

  it('returns a friendly reply on 503 / 529 (overloaded)', async () => {
    const m = recruitingManifest();
    const callAnthropicImpl = vi.fn(async () => claudeErrorResponse(529));
    const result = await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest(),
    );
    expect(result.reply).toMatch(/overloaded/i);
  });

  it('returns a friendly reply when the response shape is unexpected', async () => {
    const m = recruitingManifest();
    const callAnthropicImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { not_content: true },
      attempts: 1,
    }));
    const result = await runChatHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      makeMinimalChatRequest(),
    );
    expect(result.reply).toMatch(/unexpected response format/i);
  });
});

describe('runAgent — chat shadow mode', () => {
  it('flips final status to "shadow" and never invokes confirm-tier tool side-effects', async () => {
    const m = recruitingManifest({ shadow_mode: true });
    const sb = makeSupabaseStub(m);
    const callAnthropicImpl = vi
      .fn()
      .mockResolvedValueOnce(claudeToolUseResponse('send_sms', { message: 'hi' }))
      .mockResolvedValueOnce(claudeTextResponse('done'));
    const realExecute = vi.fn(async () => ({ ok: true, sent: true }));
    const result = await runAgent(
      sb,
      'recruiting',
      {
        shape: 'chat',
        chat: makeMinimalChatRequest({
          toolDefinitions: [{ name: 'send_sms' }],
          confirmTools: new Set(['send_sms']),
          executeTool: realExecute,
        }),
      },
      { apiKey: 'k', callAnthropicImpl, orgId: 'tc-org' },
    );
    expect(result.status).toBe('shadow');
    expect(result.shadow).toBe(true);
    // The original (live) executeTool was wrapped — it must not have been
    // reached on the confirm path.
    expect(realExecute).not.toHaveBeenCalled();
  });

  it('shadow mode lets auto-tier (read-only) tools run as normal', async () => {
    const m = recruitingManifest({ shadow_mode: true });
    const sb = makeSupabaseStub(m);
    const callAnthropicImpl = vi
      .fn()
      .mockResolvedValueOnce(
        claudeToolUseResponse('search_caregivers', { q: 'a' }),
      )
      .mockResolvedValueOnce(claudeTextResponse('done'));
    const realExecute = vi.fn(async () => ({ ok: true, found: 1 }));
    const result = await runAgent(
      sb,
      'recruiting',
      {
        shape: 'chat',
        chat: makeMinimalChatRequest({
          toolDefinitions: [{ name: 'search_caregivers' }],
          autoExecuteTools: new Set(['search_caregivers']),
          executeTool: realExecute,
        }),
      },
      { apiKey: 'k', callAnthropicImpl, orgId: 'tc-org' },
    );
    expect(realExecute).toHaveBeenCalledTimes(1);
    expect(result.toolResults?.[0]?.result).toEqual({ ok: true, found: 1 });
  });

  it('non-shadow agents return status="ok" and shadow=false', async () => {
    const m = recruitingManifest({ shadow_mode: false });
    const sb = makeSupabaseStub(m);
    const callAnthropicImpl = vi.fn(async () => claudeTextResponse('hi'));
    const result = await runAgent(
      sb,
      'recruiting',
      { shape: 'chat', chat: makeMinimalChatRequest() },
      { apiKey: 'k', callAnthropicImpl, orgId: 'tc-org' },
    );
    expect(result.status).toBe('ok');
    expect(result.shadow).toBe(false);
  });
});

// ─── runPlannerHandler tests ───

describe('runPlannerHandler', () => {
  it('makes a single Sonnet call and returns responseText', async () => {
    const m = plannerManifest();
    const callAnthropicImpl = vi.fn(async () =>
      claudeTextResponse('[{"entity_id": "x"}]', {
        input_tokens: 800,
        output_tokens: 60,
      }),
    );
    const result = await runPlannerHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      {
        mode: 'full_pipeline_daily',
        systemPrompt: 'SP',
        userPrompt: 'UP',
      },
    );
    expect(callAnthropicImpl).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
    expect(result.responseText).toBe('[{"entity_id": "x"}]');
    expect(result.cost.iterations).toBe(1);
    expect(result.cost.input_tokens).toBe(800);
    expect(result.cost.output_tokens).toBe(60);
  });

  it('honors max_tokens override', async () => {
    const m = plannerManifest();
    const callAnthropicImpl = vi.fn(async () => claudeTextResponse('[]'));
    await runPlannerHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      { mode: 'full_pipeline_daily', systemPrompt: 'sp', userPrompt: 'up', maxTokens: 4096 },
    );
    expect(callAnthropicImpl.mock.calls[0][0].body.max_tokens).toBe(4096);
  });

  it('defaults max_tokens to 2048 (matches legacy ai-planner)', async () => {
    const m = plannerManifest();
    const callAnthropicImpl = vi.fn(async () => claudeTextResponse('[]'));
    await runPlannerHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      { mode: 'full_pipeline_daily', systemPrompt: 'sp', userPrompt: 'up' },
    );
    expect(callAnthropicImpl.mock.calls[0][0].body.max_tokens).toBe(2048);
  });

  it('sends manifest.model in the request body', async () => {
    const m = plannerManifest();
    const callAnthropicImpl = vi.fn(async () => claudeTextResponse('[]'));
    await runPlannerHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      { mode: 'full_pipeline_daily', systemPrompt: 'sp', userPrompt: 'up' },
    );
    expect(callAnthropicImpl.mock.calls[0][0].body.model).toBe(m.model);
  });

  it('returns status="error" on a non-OK Anthropic response', async () => {
    const m = plannerManifest();
    const callAnthropicImpl = vi.fn(async () => claudeErrorResponse(500));
    const result = await runPlannerHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      { mode: 'full_pipeline_daily', systemPrompt: 'sp', userPrompt: 'up' },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('anthropic_error');
  });
});

// ─── runRouterHandler tests ───

describe('runRouterHandler', () => {
  it('parses the classifier JSON and returns a structured classification', async () => {
    const m = routerManifest();
    const callAnthropicImpl = vi.fn(async () =>
      claudeJsonResponse({
        intent: 'question',
        confidence: 0.9,
        suggested_action: 'send_sms',
        suggested_params: { message: 'sure!' },
        drafted_response: 'Sure, I can help.',
        reasoning: 'asked a question',
      }),
    );
    const result = await runRouterHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      { systemPrompt: 'SP', userPrompt: 'UP' },
    );
    expect(result.status).toBe('ok');
    expect(result.classification).toEqual({
      intent: 'question',
      confidence: 0.9,
      suggested_action: 'send_sms',
      suggested_params: { message: 'sure!' },
      drafted_response: 'Sure, I can help.',
      reasoning: 'asked a question',
    });
  });

  it('coerces invalid intent to "unknown"', async () => {
    const m = routerManifest();
    const callAnthropicImpl = vi.fn(async () =>
      claudeJsonResponse({
        intent: 'mystery_intent',
        confidence: 0.5,
        suggested_action: 'send_sms',
        suggested_params: {},
        drafted_response: '',
        reasoning: '',
      }),
    );
    const result = await runRouterHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      { systemPrompt: 'sp', userPrompt: 'up' },
    );
    expect(result.classification?.intent).toBe('unknown');
  });

  it('coerces invalid suggested_action to "none"', async () => {
    const m = routerManifest();
    const callAnthropicImpl = vi.fn(async () =>
      claudeJsonResponse({
        intent: 'question',
        confidence: 0.5,
        suggested_action: 'mystery_action',
        suggested_params: {},
        drafted_response: '',
        reasoning: '',
      }),
    );
    const result = await runRouterHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      { systemPrompt: 'sp', userPrompt: 'up' },
    );
    expect(result.classification?.suggested_action).toBe('none');
  });

  it('clamps confidence to [0, 1]', async () => {
    const m = routerManifest();
    const callAnthropicImpl = vi.fn(async () =>
      claudeJsonResponse({
        intent: 'question',
        confidence: 1.7,
        suggested_action: 'none',
        suggested_params: {},
        drafted_response: '',
        reasoning: '',
      }),
    );
    const result = await runRouterHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      { systemPrompt: 'sp', userPrompt: 'up' },
    );
    expect(result.classification?.confidence).toBe(1);
  });

  it('returns error on non-JSON classifier output', async () => {
    const m = routerManifest();
    const callAnthropicImpl = vi.fn(async () =>
      claudeTextResponse('I am not JSON'),
    );
    const result = await runRouterHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      { systemPrompt: 'sp', userPrompt: 'up' },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('parse_error');
    expect(result.classification).toBeNull();
  });

  it('returns error on malformed JSON', async () => {
    const m = routerManifest();
    const callAnthropicImpl = vi.fn(async () =>
      claudeTextResponse('{this is not json'),
    );
    const result = await runRouterHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      { systemPrompt: 'sp', userPrompt: 'up' },
    );
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('parse_error');
  });

  it('uses Haiku from the manifest, not a hardcoded model', async () => {
    const m = routerManifest({ model: 'claude-haiku-4-5-20251001' });
    const callAnthropicImpl = vi.fn(async () =>
      claudeJsonResponse({
        intent: 'question',
        confidence: 0.5,
        suggested_action: 'none',
        suggested_params: {},
        drafted_response: '',
        reasoning: '',
      }),
    );
    await runRouterHandler(
      m,
      { supabase: {}, apiKey: 'k', callAnthropicImpl },
      { systemPrompt: 'sp', userPrompt: 'up' },
    );
    expect(callAnthropicImpl.mock.calls[0][0].body.model).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('default intents/actions match the legacy classifier sets', () => {
    expect(ROUTER_DEFAULT_INTENTS).toEqual([
      'question',
      'document_submission',
      'scheduling_request',
      'general_response',
      'confirmation',
      'opt_out',
      'unknown',
    ]);
    expect(ROUTER_DEFAULT_ACTIONS).toContain('send_sms');
    expect(ROUTER_DEFAULT_ACTIONS).toContain('none');
    expect(ROUTER_DEFAULT_ACTIONS).toContain('send_esign_envelope');
  });
});

// ─── runAgent dispatch (full integration with mocked anthropic) ───

describe('runAgent — dispatches to the right handler by shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches shape=planner to the planner handler', async () => {
    const m = plannerManifest();
    const sb = makeSupabaseStub(m);
    const callAnthropicImpl = vi.fn(async () =>
      claudeTextResponse('[{"entity_id":"x"}]'),
    );
    const result = await runAgent(
      sb,
      'proactive_planner',
      {
        shape: 'planner',
        planner: {
          mode: 'full_pipeline_daily',
          systemPrompt: 'sp',
          userPrompt: 'up',
        },
      },
      { apiKey: 'k', callAnthropicImpl, orgId: 'tc-org' },
    );
    expect(result.status).toBe('ok');
    expect(result.agent.slug).toBe('proactive_planner');
    expect(result.reply).toBe('[{"entity_id":"x"}]');
  });

  it('dispatches shape=router to the router handler and returns classification', async () => {
    const m = routerManifest();
    const sb = makeSupabaseStub(m);
    const callAnthropicImpl = vi.fn(async () =>
      claudeJsonResponse({
        intent: 'confirmation',
        confidence: 0.95,
        suggested_action: 'add_note',
        suggested_params: { text: 'confirmed via SMS' },
        drafted_response: '',
        reasoning: 'short yes reply',
      }),
    );
    const result = await runAgent(
      sb,
      'inbound_router',
      {
        shape: 'router',
        router: { systemPrompt: 'sp', userPrompt: 'up' },
      },
      { apiKey: 'k', callAnthropicImpl, orgId: 'tc-org' },
    );
    expect(result.status).toBe('ok');
    expect(result.agent.slug).toBe('inbound_router');
    expect(result.classification?.intent).toBe('confirmation');
    expect(result.classification?.suggested_action).toBe('add_note');
  });

  it('returns the agent ref consistently across all shapes', async () => {
    const m = recruitingManifest();
    const sb = makeSupabaseStub(m);
    const callAnthropicImpl = vi.fn(async () => claudeTextResponse('hi'));
    const result = await runAgent(
      sb,
      'recruiting',
      { shape: 'chat', chat: makeMinimalChatRequest() },
      { apiKey: 'k', callAnthropicImpl, orgId: 'tc-org' },
    );
    expect(result.agent).toEqual({
      id: 'agent-recruiting-uuid',
      slug: 'recruiting',
      version: 1,
    });
  });
});
