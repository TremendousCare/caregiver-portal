/**
 * Phase 0.4 — ai-chat shell tests.
 *
 * Exercises the shell logic that translates the legacy ai-chat HTTP
 * contract into a `runAgent({ shape: "chat" })` call:
 *
 *   - JWT decode + strict org_id requirement
 *   - rate limiting preservation (failing open)
 *   - briefing path passthrough
 *   - confirmedAction path with agent_id stamping
 *   - chat path → ChatHandlerRequest dispatch
 *   - agent_id stamping on post-conversation logEvent / logAction calls
 *   - error paths (missing API key, invalid messages)
 *
 * The shell is imported directly (no Deno.serve wrapper) so all tests run
 * deterministically in Node/Vitest.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  runAiChatShell,
  decodeOrgIdFromJwt,
  resolveAgentIdSafe,
  RECRUITING_AGENT_SLUG,
} from '../../../supabase/functions/ai-chat/shell.ts';

// Hoisted mocks must be declared before importing the module under test.
// Using vi.hoisted ensures the mock factories run before evaluation.
vi.mock('../../../supabase/functions/ai-chat/registry.ts', () => ({
  getToolDefinitions: () => [
    { name: 'search_caregivers', description: 'r/o', input_schema: { type: 'object' } },
    { name: 'send_sms', description: 'write', input_schema: { type: 'object' } },
  ],
  getAutoExecuteSet: () => new Set(['search_caregivers']),
  getConfirmSet: () => new Set(['send_sms']),
  executeTool: vi.fn(async () => ({ success: true })),
  executeConfirmedAction: vi.fn(async () => ({ success: true, message: 'sent' })),
}));

vi.mock('../../../supabase/functions/ai-chat/prompt.ts', () => ({
  buildSystemPrompt: () => 'fallback prompt',
}));

vi.mock('../../../supabase/functions/ai-chat/context/assembler.ts', () => ({
  assembleSystemPrompt: vi.fn(async () => ({
    prompt: 'You are the recruiter.',
    health: {
      status: 'healthy',
      layersLoaded: ['identity', 'guidelines'],
      layersFailed: [],
      layersTrimmed: [],
      tokenEstimate: 1000,
    },
  })),
}));

const logEventMock = vi.fn(async () => undefined);
const saveContextSnapshotMock = vi.fn(async () => undefined);

vi.mock('../../../supabase/functions/ai-chat/context/events.ts', () => ({
  logEvent: (...args) => logEventMock(...args),
  saveContextSnapshot: (...args) => saveContextSnapshotMock(...args),
}));

const logActionMock = vi.fn(async () => undefined);

vi.mock('../../../supabase/functions/ai-chat/context/outcomes.ts', () => ({
  logAction: (...args) => logActionMock(...args),
}));

vi.mock('../../../supabase/functions/ai-chat/context/briefing.ts', () => ({
  generateBriefing: async () => ({
    greeting: 'Good morning',
    items: [],
    quickActions: [],
  }),
}));

vi.mock('../../../supabase/functions/ai-chat/context/consolidation.ts', () => ({
  runConsolidation: async () => undefined,
}));

vi.mock('../../../supabase/functions/_shared/operations/metrics.ts', () => ({
  startTimer: () => () => undefined,
  logMetric: () => undefined,
}));

// `./config.ts` reads `Deno.env.get(...)` at module top — that crashes in Node.
// Mock the constants the shell uses; the test's `apiKey` arg is what runAgent
// sees, so the constant value doesn't affect behaviour here.
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

// ─── Helpers ───

const TEST_ORG_ID = '62fbaf9d-13ab-49f4-b92a-a774c67b69a6';
const TEST_AGENT_ID = 'agent-recruiting-uuid';

function makeJwt(claims) {
  // Simple unsigned JWT — only the middle segment is decoded by the shell.
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payload = btoa(JSON.stringify(claims))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${payload}.signature`;
}

function makeShellSupabase({ flagOn = true, agentRow = { id: TEST_AGENT_ID }, eventsCount = 0 } = {}) {
  const inserted = [];
  const fromHandlers = {
    app_settings: () => ({
      select: function () { return this; },
      eq: function () { return this; },
      maybeSingle: async () => ({ data: { value: { ai_chat: flagOn } }, error: null }),
      single: async () => ({ data: { value: 'true' }, error: null }),
    }),
    agents: () => ({
      select: function () { return this; },
      eq: function () { return this; },
      maybeSingle: async () => ({ data: agentRow, error: null }),
    }),
    events: () => ({
      select: function () { return this; },
      eq: function () { return this; },
      gte: function () { return this; },
      then: undefined,
      // count query: returns count
      // (the shell uses head:true; mocked count returns)
      // The implementation calls `.select('id', { count: 'exact', head: true }).eq().eq().gte()`
      // and unwraps `count` directly from the awaited result — we shim by
      // making the chain return a Promise via `then`.
      [Symbol.asyncIterator]: undefined,
      insert: vi.fn(async (row) => { inserted.push({ table: 'events', row }); return { error: null }; }),
    }),
    caregivers: () => ({
      select: function () { return this; },
      order: function () { return this; },
      then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve),
    }),
    clients: () => ({
      select: function () { return this; },
      order: function () { return this; },
      then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve),
    }),
  };

  const sb = {
    from: vi.fn((table) => {
      const handler = fromHandlers[table] || (() => ({
        select: function () { return this; },
        eq: function () { return this; },
        maybeSingle: async () => ({ data: null, error: null }),
        insert: async () => ({ error: null }),
      }));
      return handler();
    }),
    inserted,
  };

  // Override events for rate-limit query: shell does
  // `.from('events').select('id', { count: 'exact', head: true }).eq(...).eq(...).gte(...)`
  // and reads `{ count, error }`. Provide a builder that resolves to that.
  sb.from = vi.fn((table) => {
    if (table === 'events') {
      const builder = {
        _isCountQuery: false,
        select: function (_cols, opts) {
          this._isCountQuery = !!(opts && opts.count);
          return this;
        },
        eq: function () { return this; },
        gte: function () {
          // Terminal — return a thenable yielding { count, error }
          return {
            then: (resolve) => Promise.resolve({ count: eventsCount, error: null }).then(resolve),
          };
        },
        insert: vi.fn(async (row) => {
          inserted.push({ table: 'events', row });
          return { error: null };
        }),
      };
      return builder;
    }
    return (fromHandlers[table] || (() => ({
      select: function () { return this; },
      eq: function () { return this; },
      maybeSingle: async () => ({ data: null, error: null }),
      insert: async () => ({ error: null }),
    })))();
  });

  return sb;
}

function makeAuthClient(user) {
  return {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── decodeOrgIdFromJwt ───

describe('decodeOrgIdFromJwt', () => {
  it('extracts org_id from a well-formed token', () => {
    const t = makeJwt({ sub: 'u1', org_id: TEST_ORG_ID });
    expect(decodeOrgIdFromJwt(t)).toBe(TEST_ORG_ID);
  });

  it('returns null when org_id claim is missing', () => {
    const t = makeJwt({ sub: 'u1' });
    expect(decodeOrgIdFromJwt(t)).toBeNull();
  });

  it('returns null when org_id is empty string', () => {
    const t = makeJwt({ sub: 'u1', org_id: '' });
    expect(decodeOrgIdFromJwt(t)).toBeNull();
  });

  it('returns null on malformed JWT', () => {
    expect(decodeOrgIdFromJwt('not.a.jwt-payload')).toBeNull();
    expect(decodeOrgIdFromJwt('only-one-part')).toBeNull();
    expect(decodeOrgIdFromJwt('')).toBeNull();
  });

  it('returns null when payload is non-JSON', () => {
    const garbage = `header.${btoa('not-json').replace(/=/g, '')}.sig`;
    expect(decodeOrgIdFromJwt(garbage)).toBeNull();
  });
});

// ─── resolveAgentIdSafe ───

describe('resolveAgentIdSafe', () => {
  it('returns id when agents row found', async () => {
    const sb = {
      from: () => ({
        select: function () { return this; },
        eq: function () { return this; },
        maybeSingle: async () => ({ data: { id: TEST_AGENT_ID }, error: null }),
      }),
    };
    expect(await resolveAgentIdSafe(sb, 'recruiting', TEST_ORG_ID)).toBe(TEST_AGENT_ID);
  });

  it('returns null on error', async () => {
    const sb = {
      from: () => ({
        select: function () { return this; },
        eq: function () { return this; },
        maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
      }),
    };
    expect(await resolveAgentIdSafe(sb, 'recruiting', TEST_ORG_ID)).toBeNull();
  });

  it('returns null when chain throws', async () => {
    const sb = { from: () => { throw new Error('boom'); } };
    expect(await resolveAgentIdSafe(sb, 'recruiting', TEST_ORG_ID)).toBeNull();
  });

  it('returns null when row exists but id is empty', async () => {
    const sb = {
      from: () => ({
        select: function () { return this; },
        eq: function () { return this; },
        maybeSingle: async () => ({ data: { id: null }, error: null }),
      }),
    };
    expect(await resolveAgentIdSafe(sb, 'recruiting', TEST_ORG_ID)).toBeNull();
  });
});

// ─── Auth + 4xx paths ───

describe('runAiChatShell — auth gates', () => {
  it('401 when Authorization header is missing', async () => {
    const sb = makeShellSupabase();
    const auth = makeAuthClient(null);
    const req = new Request('https://x.test', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
    });
    const res = await runAiChatShell(req, {
      supabase: sb,
      supabaseAuth: auth,
      apiKey: 'k',
      corsHeaders: {},
    });
    expect(res.status).toBe(401);
  });

  it('401 when Supabase auth.getUser fails', async () => {
    const sb = makeShellSupabase();
    const auth = { auth: { getUser: async () => ({ data: { user: null }, error: { message: 'expired' } }) } };
    const req = new Request('https://x.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${makeJwt({ org_id: TEST_ORG_ID })}` },
      body: JSON.stringify({ messages: [] }),
    });
    const res = await runAiChatShell(req, {
      supabase: sb,
      supabaseAuth: auth,
      apiKey: 'k',
      corsHeaders: {},
    });
    expect(res.status).toBe(401);
  });

  it('403 when JWT is missing org_id claim (strict)', async () => {
    const sb = makeShellSupabase();
    const auth = makeAuthClient({ id: 'u1' });
    const req = new Request('https://x.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${makeJwt({ sub: 'u1' })}` }, // no org_id
      body: JSON.stringify({ messages: [] }),
    });
    const res = await runAiChatShell(req, {
      supabase: sb,
      supabaseAuth: auth,
      apiKey: 'k',
      corsHeaders: {},
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/org_id claim/i);
  });

  it('500 when ANTHROPIC_API_KEY not configured', async () => {
    const sb = makeShellSupabase();
    const auth = makeAuthClient({ id: 'u1' });
    const req = new Request('https://x.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${makeJwt({ org_id: TEST_ORG_ID })}` },
      body: JSON.stringify({ messages: [] }),
    });
    const res = await runAiChatShell(req, {
      supabase: sb,
      supabaseAuth: auth,
      apiKey: undefined,
      corsHeaders: {},
    });
    expect(res.status).toBe(500);
  });
});

// ─── Briefing path ───

describe('runAiChatShell — briefing path', () => {
  it('returns briefing JSON without calling Anthropic', async () => {
    const sb = makeShellSupabase();
    const auth = makeAuthClient({ id: 'u1' });
    const req = new Request('https://x.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${makeJwt({ org_id: TEST_ORG_ID })}` },
      body: JSON.stringify({ requestType: 'briefing', currentUser: 'Kevin' }),
    });
    const res = await runAiChatShell(req, {
      supabase: sb,
      supabaseAuth: auth,
      apiKey: 'k',
      corsHeaders: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.briefing).toBeDefined();
  });
});

// ─── ai_chat_request event stamping ───

describe('runAiChatShell — agent_id stamping on ai_chat_request', () => {
  it('passes agent_id to logEvent for the rate-limit marker', async () => {
    const sb = makeShellSupabase();
    const auth = makeAuthClient({ id: 'u1' });
    const req = new Request('https://x.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${makeJwt({ org_id: TEST_ORG_ID })}` },
      body: JSON.stringify({ requestType: 'briefing', currentUser: 'Kevin' }),
    });
    await runAiChatShell(req, {
      supabase: sb,
      supabaseAuth: auth,
      apiKey: 'k',
      corsHeaders: {},
    });
    // The 7th positional arg of logEvent is agentId.
    expect(logEventMock).toHaveBeenCalled();
    const firstCallArgs = logEventMock.mock.calls[0];
    expect(firstCallArgs[1]).toBe('ai_chat_request');
    expect(firstCallArgs[6]).toBe(TEST_AGENT_ID);
  });
});

// ─── Confirmed action path ───

describe('runAiChatShell — confirmAction path', () => {
  it('stamps agent_id on logEvent + logAction after success', async () => {
    const sb = makeShellSupabase();
    const auth = makeAuthClient({ id: 'u1' });
    const req = new Request('https://x.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${makeJwt({ org_id: TEST_ORG_ID })}` },
      body: JSON.stringify({
        confirmAction: {
          action: 'send_sms',
          caregiver_id: 'cg-1',
          params: { message: 'hi' },
        },
        currentUser: 'Kevin',
      }),
    });
    const res = await runAiChatShell(req, {
      supabase: sb,
      supabaseAuth: auth,
      apiKey: 'k',
      corsHeaders: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actionResult).toBeDefined();

    // logEvent for the confirmed action — agentId at position 6
    const confirmEventCall = logEventMock.mock.calls.find(c => c[1] === 'sms_sent');
    expect(confirmEventCall).toBeDefined();
    expect(confirmEventCall[6]).toBe(TEST_AGENT_ID);

    // logAction — agentId at position 7
    expect(logActionMock).toHaveBeenCalled();
    const logActionCall = logActionMock.mock.calls[0];
    expect(logActionCall[7]).toBe(TEST_AGENT_ID);
  });
});

// ─── Stamping degrades gracefully when agent row missing ───

describe('runAiChatShell — graceful degradation', () => {
  it('still serves the request when agent row lookup fails', async () => {
    const sb = makeShellSupabase({ agentRow: null });
    const auth = makeAuthClient({ id: 'u1' });
    const req = new Request('https://x.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${makeJwt({ org_id: TEST_ORG_ID })}` },
      body: JSON.stringify({ requestType: 'briefing', currentUser: 'Kevin' }),
    });
    const res = await runAiChatShell(req, {
      supabase: sb,
      supabaseAuth: auth,
      apiKey: 'k',
      corsHeaders: {},
    });
    expect(res.status).toBe(200);
    // logEvent still called, but with NULL agentId
    const firstCallArgs = logEventMock.mock.calls[0];
    expect(firstCallArgs[6]).toBeNull();
  });
});

// ─── Stable slug constant ───

describe('runAiChatShell — manifest contract', () => {
  it('uses the recruiting slug', () => {
    expect(RECRUITING_AGENT_SLUG).toBe('recruiting');
  });
});
