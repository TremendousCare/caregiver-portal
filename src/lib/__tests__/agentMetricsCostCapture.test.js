/**
 * Phase 1.4 — Per-agent metrics dashboard, cost & latency capture.
 *
 * The dashboard reads `agent_actions.payload._cost` to surface token spend
 * and latency. The three agent shells (ai-chat, ai-planner, message-router)
 * are responsible for stamping that shape on every `recordAgentAction`
 * call. These tests pin the contract:
 *
 *   payload._cost = {
 *     input_tokens: number,
 *     output_tokens: number,
 *     duration_ms: number,
 *     model: string | null,
 *   }
 *
 * If a future change to a shell drops the field, the dashboard's token
 * spend chart silently zeros out — these tests fail loudly instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordAgentActionMock = vi.fn(async () => ({ ok: true }));

// Preserve every other export of `agentActions.ts` (the crypto helpers,
// constants, etc.) so other test files that share the module registry
// keep working. Only `recordAgentAction` is replaced with our capture
// spy.
vi.mock('../../../supabase/functions/_shared/operations/agentActions.ts', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    recordAgentAction: (...args) => recordAgentActionMock(...args),
  };
});

// Shared mocks for the runtime — each test overrides runAgent's return.
// As with agentActions, we preserve every other export (the type
// definitions don't matter at runtime, but `ZERO_COST`, internal
// helpers, etc. may be referenced by other tests sharing the module
// registry under the default thread pool).
const runAgentMock = vi.fn();

vi.mock('../../../supabase/functions/_shared/operations/agentRuntime.ts', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    runAgent: (...args) => runAgentMock(...args),
  };
});

vi.mock('../../../supabase/functions/_shared/operations/metrics.ts', () => ({
  startTimer: () => () => undefined,
  logMetric: () => undefined,
}));

// ─── ai-chat shell deps ───

vi.mock('../../../supabase/functions/ai-chat/registry.ts', () => ({
  getToolDefinitions: () => [],
  getAutoExecuteSet: () => new Set(),
  getConfirmSet: () => new Set(),
  executeTool: vi.fn(async () => ({ success: true })),
  executeConfirmedAction: vi.fn(async () => ({ success: true, message: 'sent' })),
}));

vi.mock('../../../supabase/functions/ai-chat/prompt.ts', () => ({
  buildSystemPrompt: () => 'fallback prompt',
}));

vi.mock('../../../supabase/functions/ai-chat/context/assembler.ts', () => ({
  assembleSystemPrompt: vi.fn(async () => ({
    prompt: 'sys',
    health: { status: 'healthy', layersLoaded: [], layersFailed: [], layersTrimmed: [], tokenEstimate: 0 },
  })),
}));

vi.mock('../../../supabase/functions/ai-chat/context/events.ts', () => ({
  logEvent: vi.fn(async () => undefined),
  saveContextSnapshot: vi.fn(async () => undefined),
}));

vi.mock('../../../supabase/functions/ai-chat/context/outcomes.ts', () => ({
  logAction: vi.fn(async () => undefined),
}));

vi.mock('../../../supabase/functions/ai-chat/context/briefing.ts', () => ({
  generateBriefing: async () => ({ greeting: 'hi', items: [], quickActions: [] }),
}));

vi.mock('../../../supabase/functions/ai-chat/context/consolidation.ts', () => ({
  runConsolidation: async () => undefined,
}));

vi.mock('../../../supabase/functions/ai-chat/config.ts', () => ({
  ANTHROPIC_API_KEY: 'test-key',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc-role',
  SUPABASE_ANON_KEY: 'anon',
  CLAUDE_MODEL: 'claude-sonnet-4-5-20250929',
  MAX_TOKENS: 4096,
  RATE_LIMIT_MAX_REQUESTS: 60,
  RATE_LIMIT_WINDOW_MS: 3_600_000,
  getCorsHeaders: () => ({}),
}));

// ─── ai-planner shell deps ───

vi.mock('../../../supabase/functions/_shared/operations/planner.ts', () => ({
  buildPipelineSummary: () => ({ entities: [{ id: 'cg-1', kind: 'caregiver' }] }),
  formatPipelineSummaryForPrompt: () => 'PIPELINE',
  formatSingleEntityPrompt: () => 'SINGLE',
  parsePlannerResponse: vi.fn(() => [
    {
      entity_id: 'cg-1',
      entity_type: 'caregiver',
      entity_name: 'Jane Doe',
      action_type: 'send_sms',
      priority: 'high',
      title: 'Follow up',
      detail: 'Hasn\'t responded',
      drafted_content: 'Hi Jane',
      action_params: { message: 'Hi Jane' },
    },
  ]),
  checkDuplicateSuggestion: vi.fn(async () => false),
}));

// Preserve every export of routing.ts (including `recordAutonomyOutcome`,
// which is used in cross-file integration paths) and only override the
// handful we need for these tests. Wholesale replacement leaks across
// test files when vitest reuses the module registry under the threads
// pool and breaks `recordAutonomyOutcomeWiring.test.js`.
vi.mock('../../../supabase/functions/_shared/operations/routing.ts', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    lookupAutonomyLevel: vi.fn(async () => ({ autonomy_level: 'L1' })),
    executeSuggestion: vi.fn(async () => ({ success: true })),
    fetchEntityContext: vi.fn(async () => ({
      entity_id: 'cg-1',
      entity_type: 'caregiver',
      first_name: 'Jane',
      last_name: 'Doe',
      phase: 'Onboarding',
      phone: '+15555555555',
      email: null,
      incomplete_tasks: [],
      recent_notes: [],
      business_context: '',
      conversation_history: [],
    })),
    createSuggestion: vi.fn(async () => ({ success: true })),
  };
});

vi.mock('../../../supabase/functions/_shared/operations/shiftOfferMatching.ts', () => ({
  matchInboundShiftOfferResponse: vi.fn(async () => ({ matched: false })),
}));

// ─── Imports (after all mocks) ───

import { runAiChatShell } from '../../../supabase/functions/ai-chat/shell.ts';
import { runAiPlannerShell } from '../../../supabase/functions/ai-planner/shell.ts';
import { runMessageRouterShell } from '../../../supabase/functions/message-router/shell.ts';

const TEST_ORG_ID = '62fbaf9d-13ab-49f4-b92a-a774c67b69a6';
const TEST_AGENT_ID = 'agent-uuid';
const TEST_MODEL = 'claude-sonnet-4-5-20250929';

function makeJwt(claims) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payload = btoa(JSON.stringify(claims))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${payload}.signature`;
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAgentActionMock.mockResolvedValue({ ok: true });
});

// ─── ai-chat shell ───

describe('ai-chat shell — payload._cost stamping (Phase 1.4)', () => {
  function makeChatSupabase() {
    const eventsBuilder = () => {
      let isCount = false;
      const b = {
        select(_, opts) { isCount = !!(opts && opts.count); return b; },
        eq() { return b; },
        gte() {
          return { then: (r) => Promise.resolve({ count: 0, error: null }).then(r) };
        },
        insert: vi.fn(async () => ({ error: null })),
      };
      return b;
    };
    return {
      from: vi.fn((table) => {
        if (table === 'agents') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: { id: TEST_AGENT_ID, version: 3 }, error: null }),
          };
        }
        if (table === 'events') return eventsBuilder();
        if (table === 'caregivers' || table === 'clients') {
          return {
            select() { return this; },
            order() { return this; },
            then: (r) => Promise.resolve({ data: [], error: null }).then(r),
          };
        }
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
          insert: async () => ({ error: null }),
        };
      }),
    };
  }

  it('stamps _cost (input_tokens, output_tokens, duration_ms, model) on agent_actions for tool executions', async () => {
    runAgentMock.mockResolvedValue({
      status: 'ok',
      reply: 'done',
      toolResults: [
        {
          tool: 'send_sms',
          input: { message: 'hi' },
          result: { success: true, caregiver_id: 'cg-1', entity_name: 'Jane' },
        },
      ],
      cost: { input_tokens: 1234, output_tokens: 567, iterations: 2, duration_ms: 4500 },
      agent: { id: TEST_AGENT_ID, slug: 'recruiting', version: 3, model: TEST_MODEL },
      shadow: false,
    });

    const sb = makeChatSupabase();
    const auth = { auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } };
    const req = new Request('https://x.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${makeJwt({ org_id: TEST_ORG_ID })}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'ok' }],
        currentUser: 'Jessica',
      }),
    });

    await runAiChatShell(req, { supabase: sb, supabaseAuth: auth, apiKey: 'k', corsHeaders: {} });

    expect(recordAgentActionMock).toHaveBeenCalled();
    const callArg = recordAgentActionMock.mock.calls[0][1];
    expect(callArg.payload._cost).toBeDefined();
    expect(callArg.payload._cost.input_tokens).toBe(1234);
    expect(callArg.payload._cost.output_tokens).toBe(567);
    expect(typeof callArg.payload._cost.duration_ms).toBe('number');
    expect(callArg.payload._cost.duration_ms).toBeGreaterThanOrEqual(0);
    expect(callArg.payload._cost.model).toBe(TEST_MODEL);
  });

  it('stamps _cost.model=null when manifest model unavailable', async () => {
    runAgentMock.mockResolvedValue({
      status: 'ok',
      reply: 'done',
      toolResults: [
        {
          tool: 'send_sms',
          input: { message: 'hi' },
          result: { success: true, caregiver_id: 'cg-1', entity_name: 'Jane' },
        },
      ],
      cost: { input_tokens: 100, output_tokens: 50, iterations: 1, duration_ms: 200 },
      agent: { id: TEST_AGENT_ID, slug: 'recruiting', version: 3, model: '' },
      shadow: false,
    });

    const sb = makeChatSupabase();
    const auth = { auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } };
    const req = new Request('https://x.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${makeJwt({ org_id: TEST_ORG_ID })}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' }],
        currentUser: 'Jessica',
      }),
    });

    await runAiChatShell(req, { supabase: sb, supabaseAuth: auth, apiKey: 'k', corsHeaders: {} });

    expect(recordAgentActionMock).toHaveBeenCalled();
    const callArg = recordAgentActionMock.mock.calls[0][1];
    expect(callArg.payload._cost.model).toBeNull();
  });
});

// ─── ai-planner shell ───

describe('ai-planner shell — payload._cost stamping (Phase 1.4)', () => {
  function makePlannerSupabase() {
    return {
      from: vi.fn((table) => {
        if (table === 'app_settings') {
          let filterKey = null;
          const b = {
            select() { return b; },
            eq(_, val) { filterKey = val; return b; },
            single: async () => {
              if (filterKey === 'planner_enabled') return { data: { value: true }, error: null };
              if (filterKey === 'last_planner_run') return { data: null, error: null };
              if (filterKey === 'planner_max_suggestions') return { data: { value: 7 }, error: null };
              if (filterKey === 'ai_business_context') return { data: { value: '' }, error: null };
              return { data: null, error: null };
            },
            upsert: async () => ({ error: null }),
          };
          return b;
        }
        if (table === 'organizations') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: { id: TEST_ORG_ID }, error: null }),
          };
        }
        if (table === 'agents') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: { id: TEST_AGENT_ID }, error: null }),
          };
        }
        if (table === 'ai_suggestions') {
          const b = {
            select() { return b; },
            eq() { return b; },
            gte() { return b; },
            order() { return b; },
            limit() {
              return { then: (r) => Promise.resolve({ data: [], error: null }).then(r) };
            },
            insert() {
              const chain = {
                select() { return chain; },
                single: async () => ({ data: { id: 'sug-1' }, error: null }),
              };
              return chain;
            },
          };
          return b;
        }
        // caregivers / clients / action_outcomes / action_item_rules / automation_rules
        return {
          select() { return this; },
          eq() { return this; },
          gte() { return this; },
          order() { return this; },
          limit() { return this; },
          single: async () => ({ data: { id: 'cg-1', first_name: 'Jane', last_name: 'Doe' }, error: null }),
          then: (r) => Promise.resolve({ data: [{ id: 'cg-1' }], error: null }).then(r),
        };
      }),
    };
  }

  it('stamps _cost on every planner suggestion audit row, prorated across N suggestions', async () => {
    runAgentMock.mockResolvedValue({
      status: 'ok',
      reply: JSON.stringify([]),
      cost: { input_tokens: 1000, output_tokens: 200, iterations: 1, duration_ms: 3200 },
      agent: { id: TEST_AGENT_ID, slug: 'proactive_planner', version: 2, model: TEST_MODEL },
      shadow: false,
    });

    const sb = makePlannerSupabase();
    await runAiPlannerShell(
      new Request('https://x', { method: 'POST', body: JSON.stringify({}) }),
      { supabase: sb, apiKey: 'k' },
    );

    expect(recordAgentActionMock).toHaveBeenCalled();
    const callArg = recordAgentActionMock.mock.calls[0][1];
    expect(callArg.payload._cost).toBeDefined();
    // 1 suggestion in parsePlannerResponse mock → prorated tokens = full session
    expect(callArg.payload._cost.input_tokens).toBe(1000);
    expect(callArg.payload._cost.output_tokens).toBe(200);
    expect(callArg.payload._cost.duration_ms).toBe(3200);
    expect(callArg.payload._cost.model).toBe(TEST_MODEL);
  });
});

// ─── message-router shell ───

describe('message-router shell — payload._cost stamping (Phase 1.4)', () => {
  function makeRouterSupabase() {
    const queueRow = {
      id: 'q-1',
      channel: 'sms',
      sender_identifier: '+15555555555',
      message_text: 'hello',
      matched_entity_type: 'caregiver',
      matched_entity_id: 'cg-1',
      attempts: 0,
      received_at: '2026-05-12T00:00:00Z',
      created_at: '2026-05-12T00:00:00Z',
    };

    return {
      from: vi.fn((table) => {
        if (table === 'organizations') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: { id: TEST_ORG_ID }, error: null }),
          };
        }
        if (table === 'agents') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: { id: TEST_AGENT_ID }, error: null }),
          };
        }
        if (table === 'message_routing_queue') {
          const b = {
            select() { return b; },
            eq() { return b; },
            in() { return b; },
            order() { return b; },
            limit() {
              return { then: (r) => Promise.resolve({ data: [queueRow], error: null }).then(r) };
            },
            update() {
              return {
                in() { return { eq: async () => ({ error: null }) }; },
                eq: async () => ({ error: null }),
              };
            },
          };
          return b;
        }
        if (table === 'ai_suggestions') {
          const b = {
            select() { return b; },
            eq() { return b; },
            gte() { return b; },
            order() { return b; },
            limit() {
              return { then: (r) => Promise.resolve({ data: [], error: null }).then(r) };
            },
            insert: async () => ({ error: null }),
          };
          return b;
        }
        return {
          select() { return this; },
          eq() { return this; },
          gte() { return this; },
          order() { return this; },
          limit() { return this; },
          then: (r) => Promise.resolve({ data: [], error: null }).then(r),
          insert: async () => ({ error: null }),
        };
      }),
    };
  }

  it('stamps _cost on inbound classification audit row', async () => {
    runAgentMock.mockResolvedValue({
      status: 'ok',
      reply: 'ack',
      classification: {
        intent: 'general_response',
        confidence: 0.85,
        suggested_action: 'send_sms',
        suggested_params: {},
        drafted_response: 'Got it!',
        reasoning: 'casual reply',
      },
      cost: { input_tokens: 800, output_tokens: 120, iterations: 1, duration_ms: 1800 },
      agent: { id: TEST_AGENT_ID, slug: 'inbound_router', version: 1, model: TEST_MODEL },
      shadow: false,
    });

    const sb = makeRouterSupabase();
    await runMessageRouterShell(
      new Request('https://x', { method: 'POST', body: JSON.stringify({}) }),
      { supabase: sb, apiKey: 'k' },
    );

    expect(recordAgentActionMock).toHaveBeenCalled();
    const callArg = recordAgentActionMock.mock.calls[0][1];
    expect(callArg.payload._cost).toBeDefined();
    expect(callArg.payload._cost.input_tokens).toBe(800);
    expect(callArg.payload._cost.output_tokens).toBe(120);
    expect(callArg.payload._cost.duration_ms).toBe(1800);
    expect(callArg.payload._cost.model).toBe(TEST_MODEL);
  });
});
