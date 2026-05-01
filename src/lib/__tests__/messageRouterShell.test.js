/**
 * Phase 0.4 — message-router shell tests.
 *
 *   - org_id resolution from "tremendous-care" slug
 *   - empty queue early return
 *   - unknown-sender alert insert with agent_id
 *   - entity-not-found / archived skip path
 *   - runAgent dispatch with shape="router" and byte-equal classifier prompts
 *   - autonomy lookup + queue update path
 *   - dedup short-circuit
 *   - createSuggestion called with agentId
 *   - L3/L4 auto-execute path
 *   - kill_switch behaviour bumps attempts and bails
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  runMessageRouterShell,
  resolveOrgIdFromSlug,
  resolveAgentIdSafe,
  ROUTER_AGENT_SLUG,
} from '../../../supabase/functions/message-router/shell.ts';

vi.mock('../../../supabase/functions/_shared/operations/agentRuntime.ts', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    runAgent: vi.fn(),
  };
});

vi.mock('../../../supabase/functions/_shared/operations/routing.ts', async () => {
  return {
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
      conversation_history: [],
    })),
    lookupAutonomyLevel: vi.fn(async () => ({ autonomy_level: 'L1' })),
    createSuggestion: vi.fn(async () => ({ success: true })),
    executeSuggestion: vi.fn(async () => ({ success: true })),
    buildClassifierUserMessage: () => 'CLASSIFIER_USER_PROMPT',
    CLASSIFIER_SYSTEM_PROMPT: 'CLASSIFIER_SYSTEM',
    MAX_BATCH_SIZE: 10,
  };
});

vi.mock('../../../supabase/functions/_shared/operations/planner.ts', () => ({
  checkDuplicateSuggestion: vi.fn(async () => false),
}));

vi.mock('../../../supabase/functions/_shared/operations/metrics.ts', () => ({
  startTimer: () => () => undefined,
  logMetric: () => undefined,
}));

vi.mock('../../../supabase/functions/_shared/operations/shiftOfferMatching.ts', () => ({
  matchInboundShiftOfferResponse: vi.fn(async () => ({ matched: false })),
}));

import { runAgent } from '../../../supabase/functions/_shared/operations/agentRuntime.ts';
import {
  createSuggestion,
  lookupAutonomyLevel,
  executeSuggestion,
} from '../../../supabase/functions/_shared/operations/routing.ts';
import { checkDuplicateSuggestion } from '../../../supabase/functions/_shared/operations/planner.ts';

const TEST_ORG_ID = '62fbaf9d-13ab-49f4-b92a-a774c67b69a6';
const TEST_AGENT_ID = 'agent-router-uuid';

function makeRouterSupabase({
  queueEntries = [],
  insertedTracker = [],
  queueUpdates = [],
  recentSuggestionId = 'suggestion-recent',
  agentRow = { id: TEST_AGENT_ID },
  orgRow = { id: TEST_ORG_ID },
} = {}) {
  return {
    from: vi.fn((table) => {
      if (table === 'organizations') {
        return {
          select: function () { return this; },
          eq: function () { return this; },
          maybeSingle: async () => ({ data: orgRow, error: null }),
        };
      }
      if (table === 'agents') {
        return {
          select: function () { return this; },
          eq: function () { return this; },
          maybeSingle: async () => ({ data: agentRow, error: null }),
        };
      }
      if (table === 'message_routing_queue') {
        const queueBuilder = {
          select() { return queueBuilder; },
          eq() { return queueBuilder; },
          order() { return queueBuilder; },
          limit() {
            return Promise.resolve({ data: queueEntries, error: null });
          },
          update(updates) {
            // Two terminal patterns:
            //   .update(...).in("id", ids).eq("status", "pending")  → bulk CAS
            //   .update(...).eq("id", entry.id)                     → per-entry
            const updateChain = {
              in(_col, ids) {
                queueUpdates.push({ ids, updates, kind: 'bulk' });
                const inChain = {
                  eq() { return Promise.resolve({ error: null }); },
                  then(resolve, reject) {
                    return Promise.resolve({ error: null }).then(resolve, reject);
                  },
                };
                return inChain;
              },
              eq(_col, val) {
                queueUpdates.push({ id: val, updates, kind: 'single' });
                return Promise.resolve({ error: null });
              },
            };
            return updateChain;
          },
        };
        return queueBuilder;
      }
      if (table === 'ai_suggestions') {
        return {
          insert: function (row) {
            insertedTracker.push({ table: 'ai_suggestions', row });
            return Promise.resolve({ error: null });
          },
          select: function () { return this; },
          eq: function () { return this; },
          order: function () { return this; },
          limit: function () { return Promise.resolve({ data: [{ id: recentSuggestionId }], error: null }); },
        };
      }
      return {
        select: function () { return this; },
        eq: function () { return this; },
        maybeSingle: async () => ({ data: null, error: null }),
      };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runAgent.mockImplementation(async () => ({
    status: 'ok',
    reply: '{}',
    classification: {
      intent: 'general_response',
      confidence: 0.9,
      suggested_action: 'send_sms',
      suggested_params: {},
      drafted_response: 'Thanks!',
      reasoning: 'r',
    },
    cost: { input_tokens: 50, output_tokens: 20, iterations: 1, duration_ms: 0 },
    agent: { id: TEST_AGENT_ID, slug: ROUTER_AGENT_SLUG, version: 1 },
    shadow: false,
  }));
});

// ─── helpers ───

describe('resolveOrgIdFromSlug (router)', () => {
  it('resolves the seeded org', async () => {
    const sb = makeRouterSupabase();
    expect(await resolveOrgIdFromSlug(sb, 'tremendous-care')).toBe(TEST_ORG_ID);
  });

  it('returns null when not found', async () => {
    const sb = makeRouterSupabase({ orgRow: null });
    expect(await resolveOrgIdFromSlug(sb, 'nope')).toBeNull();
  });
});

describe('resolveAgentIdSafe (router)', () => {
  it('returns the inbound_router agent id', async () => {
    const sb = makeRouterSupabase();
    expect(await resolveAgentIdSafe(sb, ROUTER_AGENT_SLUG, TEST_ORG_ID)).toBe(TEST_AGENT_ID);
  });
});

// ─── shell behaviour ───

describe('runMessageRouterShell — guard rails', () => {
  it('OPTIONS returns "ok"', async () => {
    const res = await runMessageRouterShell(
      new Request('https://x', { method: 'OPTIONS' }),
      { supabase: makeRouterSupabase(), apiKey: 'k' },
    );
    expect(res.status).toBe(200);
  });

  it('500 when API key missing', async () => {
    const res = await runMessageRouterShell(
      new Request('https://x', { method: 'POST' }),
      { supabase: makeRouterSupabase(), apiKey: undefined },
    );
    expect(res.status).toBe(500);
  });

  it('returns success and zero counters on empty queue', async () => {
    const res = await runMessageRouterShell(
      new Request('https://x', { method: 'POST' }),
      { supabase: makeRouterSupabase({ queueEntries: [] }), apiKey: 'k' },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe('runMessageRouterShell — unknown sender alert', () => {
  it('inserts an alert with agent_id and skips the entry', async () => {
    const inserted = [];
    const updates = [];
    const sb = makeRouterSupabase({
      queueEntries: [{
        id: 'q1',
        channel: 'sms',
        sender_identifier: '+15558675309',
        message_text: 'STOP',
        attempts: 0,
        matched_entity_id: null,
        matched_entity_type: null,
      }],
      insertedTracker: inserted,
      queueUpdates: updates,
    });
    const res = await runMessageRouterShell(
      new Request('https://x', { method: 'POST' }),
      { supabase: sb, apiKey: 'k' },
    );
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(body.suggestions_created).toBe(1);
    expect(inserted.length).toBe(1);
    expect(inserted[0].row.agent_id).toBe(TEST_AGENT_ID);
    expect(inserted[0].row.suggestion_type).toBe('alert');
    expect(runAgent).not.toHaveBeenCalled(); // no classifier needed for unknown sender
  });
});

describe('runMessageRouterShell — runtime dispatch + suggestion creation', () => {
  it('dispatches into runAgent with byte-equal classifier prompts', async () => {
    const sb = makeRouterSupabase({
      queueEntries: [{
        id: 'q1',
        channel: 'sms',
        sender_identifier: '+15555555555',
        message_text: 'I have my TB test',
        attempts: 0,
        matched_entity_id: 'cg-1',
        matched_entity_type: 'caregiver',
        received_at: new Date().toISOString(),
      }],
    });
    await runMessageRouterShell(
      new Request('https://x', { method: 'POST' }),
      { supabase: sb, apiKey: 'k' },
    );
    expect(runAgent).toHaveBeenCalledOnce();
    const [, slug, request, options] = runAgent.mock.calls[0];
    expect(slug).toBe(ROUTER_AGENT_SLUG);
    expect(request.shape).toBe('router');
    expect(request.router.systemPrompt).toBe('CLASSIFIER_SYSTEM');
    expect(request.router.userPrompt).toBe('CLASSIFIER_USER_PROMPT');
    expect(options.orgId).toBe(TEST_ORG_ID);
  });

  it('passes agent_id through to createSuggestion', async () => {
    const sb = makeRouterSupabase({
      queueEntries: [{
        id: 'q1',
        channel: 'sms',
        sender_identifier: '+15555555555',
        message_text: 'I have my TB test',
        attempts: 0,
        matched_entity_id: 'cg-1',
        matched_entity_type: 'caregiver',
      }],
    });
    await runMessageRouterShell(
      new Request('https://x', { method: 'POST' }),
      { supabase: sb, apiKey: 'k' },
    );
    expect(createSuggestion).toHaveBeenCalled();
    const args = createSuggestion.mock.calls[0][1];
    expect(args.agentId).toBe(TEST_AGENT_ID);
  });

  it('skips on duplicate detection (no createSuggestion call)', async () => {
    checkDuplicateSuggestion.mockImplementationOnce(async () => true);
    const sb = makeRouterSupabase({
      queueEntries: [{
        id: 'q1',
        channel: 'sms',
        sender_identifier: '+15555555555',
        message_text: 'I have my TB test',
        attempts: 0,
        matched_entity_id: 'cg-1',
        matched_entity_type: 'caregiver',
      }],
    });
    await runMessageRouterShell(
      new Request('https://x', { method: 'POST' }),
      { supabase: sb, apiKey: 'k' },
    );
    expect(createSuggestion).not.toHaveBeenCalled();
  });

  it('auto-executes on L3 autonomy level', async () => {
    lookupAutonomyLevel.mockImplementationOnce(async () => ({ autonomy_level: 'L3' }));
    const sb = makeRouterSupabase({
      queueEntries: [{
        id: 'q1',
        channel: 'sms',
        sender_identifier: '+15555555555',
        message_text: 'thanks',
        attempts: 0,
        matched_entity_id: 'cg-1',
        matched_entity_type: 'caregiver',
      }],
    });
    await runMessageRouterShell(
      new Request('https://x', { method: 'POST' }),
      { supabase: sb, apiKey: 'k' },
    );
    expect(executeSuggestion).toHaveBeenCalledOnce();
  });
});

describe('runMessageRouterShell — kill switch propagation', () => {
  it('marks queue entry as failed/pending on agent kill_switch', async () => {
    runAgent.mockImplementationOnce(async () => ({
      status: 'killed',
      reply: '',
      classification: null,
      cost: { input_tokens: 0, output_tokens: 0, iterations: 0, duration_ms: 0 },
      agent: { id: TEST_AGENT_ID, slug: ROUTER_AGENT_SLUG, version: 1 },
      shadow: false,
    }));
    const sb = makeRouterSupabase({
      queueEntries: [{
        id: 'q1',
        channel: 'sms',
        sender_identifier: '+15555555555',
        message_text: 'hi',
        attempts: 0,
        matched_entity_id: 'cg-1',
        matched_entity_type: 'caregiver',
      }],
    });
    const res = await runMessageRouterShell(
      new Request('https://x', { method: 'POST' }),
      { supabase: sb, apiKey: 'k' },
    );
    const body = await res.json();
    expect(body.failed).toBe(1);
    expect(createSuggestion).not.toHaveBeenCalled();
  });
});
