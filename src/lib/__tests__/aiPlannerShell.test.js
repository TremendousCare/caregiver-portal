/**
 * Phase 0.4 — ai-planner shell tests.
 *
 * The planner cron runs without a JWT, so the shell resolves org_id from
 * the `organizations.slug = 'tremendous-care'` row. We verify:
 *
 *   - org_id resolution (success + failure)
 *   - planner_enabled flag honored
 *   - daily idempotency (`last_planner_run`) honored
 *   - single-entity 30-min dedup honored
 *   - empty-pipeline early return
 *   - runAgent dispatch with shape="planner"
 *   - ai_suggestions inserts carry `agent_id`
 *   - kill_switch behaviour returns "skipped" without writing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  runAiPlannerShell,
  resolveOrgIdFromSlug,
  resolveAgentIdSafe,
  PLANNER_AGENT_SLUG,
} from '../../../supabase/functions/ai-planner/shell.ts';

// Mock the Anthropic call by stubbing runAgent's internal module so we
// control what comes back without standing up the full mocked supabase
// the runtime expects for manifest loading.
vi.mock('../../../supabase/functions/_shared/operations/agentRuntime.ts', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    runAgent: vi.fn(),
  };
});

vi.mock('../../../supabase/functions/_shared/operations/planner.ts', () => ({
  buildPipelineSummary: () => ({ entities: [{ id: 'cg-1', kind: 'caregiver' }] }),
  formatPipelineSummaryForPrompt: () => 'PIPELINE_DUMP',
  formatSingleEntityPrompt: () => 'SINGLE_ENTITY_DUMP',
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

vi.mock('../../../supabase/functions/_shared/operations/routing.ts', () => ({
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
}));

vi.mock('../../../supabase/functions/_shared/operations/metrics.ts', () => ({
  startTimer: () => () => undefined,
  logMetric: () => undefined,
}));

import { runAgent } from '../../../supabase/functions/_shared/operations/agentRuntime.ts';

const TEST_ORG_ID = '62fbaf9d-13ab-49f4-b92a-a774c67b69a6';
const TEST_AGENT_ID = 'agent-planner-uuid';

function makePlannerSupabase({
  enabled = true,
  lastRunDate = null,           // null = never; "today" = today's date
  recentTriggerExists = false,  // single-entity 30-min dedup
  insertedTracker = [],
  upsertedTracker = [],
  agentRow = { id: TEST_AGENT_ID },
  orgRow = { id: TEST_ORG_ID },
} = {}) {
  const today = new Date().toISOString().split('T')[0];

  function appSettingsBuilder() {
    let filterKey = null;
    const builder = {
      select() { return builder; },
      eq(_col, val) { filterKey = val; return builder; },
      single: async () => {
        if (filterKey === 'planner_enabled') {
          return { data: { value: enabled ? true : false }, error: null };
        }
        if (filterKey === 'last_planner_run') {
          if (lastRunDate === 'today') return { data: { value: `${today}T12:00:00Z` }, error: null };
          return { data: null, error: null };
        }
        if (filterKey === 'planner_max_suggestions') {
          return { data: { value: 7 }, error: null };
        }
        if (filterKey === 'ai_business_context') {
          return { data: { value: '' }, error: null };
        }
        return { data: null, error: null };
      },
      upsert: async (row) => { upsertedTracker.push({ table: 'app_settings', row }); return { error: null }; },
    };
    return builder;
  }

  function orgsBuilder() {
    return {
      select() { return this; },
      eq() { return this; },
      maybeSingle: async () => ({ data: orgRow, error: null }),
    };
  }

  function agentsBuilder() {
    return {
      select() { return this; },
      eq() { return this; },
      maybeSingle: async () => ({ data: agentRow, error: null }),
    };
  }

  function thenableBuilder(data) {
    const builder = {
      select() { return builder; },
      eq() { return builder; },
      gte() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      then(resolve, reject) {
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function caregiversOrClientsBuilder(data) {
    const b = thenableBuilder(data);
    b.single = async () => ({ data: { id: 'cg-1', first_name: 'Jane', last_name: 'Doe' }, error: null });
    return b;
  }

  function aiSuggestionsBuilder() {
    let isInsertChain = false;
    const builder = {
      select() { return builder; },
      eq() { return builder; },
      gte() { return builder; },
      // Terminal limit() in dedup path returns thenable result
      limit() {
        return {
          then: (resolve, reject) =>
            Promise.resolve({ data: recentTriggerExists ? [{ id: 'old' }] : [], error: null }).then(resolve, reject),
        };
      },
      insert(row) {
        insertedTracker.push({ table: 'ai_suggestions', row });
        const insertChain = {
          select() { return insertChain; },
          single: async () => ({ data: { id: `suggestion-${insertedTracker.length}` }, error: null }),
        };
        return insertChain;
      },
    };
    return builder;
  }

  return {
    from: vi.fn((table) => {
      if (table === 'app_settings') return appSettingsBuilder();
      if (table === 'organizations') return orgsBuilder();
      if (table === 'agents') return agentsBuilder();
      if (table === 'action_item_rules' || table === 'automation_rules') return thenableBuilder([]);
      if (table === 'action_outcomes') return thenableBuilder([]);
      if (table === 'caregivers' || table === 'clients') return caregiversOrClientsBuilder([{ id: 'cg-1' }]);
      if (table === 'ai_suggestions') return aiSuggestionsBuilder();
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: null, error: null }),
      };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default runAgent stub: returns a 1-suggestion JSON response.
  runAgent.mockImplementation(async () => ({
    status: 'ok',
    reply: '[]', // overridden per test
    cost: { input_tokens: 100, output_tokens: 50, iterations: 1, duration_ms: 0 },
    agent: { id: TEST_AGENT_ID, slug: PLANNER_AGENT_SLUG, version: 1 },
    shadow: false,
  }));
});

// ─── helpers ───

describe('resolveOrgIdFromSlug', () => {
  it('resolves the seeded tremendous-care org id', async () => {
    const sb = makePlannerSupabase();
    expect(await resolveOrgIdFromSlug(sb, 'tremendous-care')).toBe(TEST_ORG_ID);
  });

  it('returns null when org row missing', async () => {
    const sb = {
      from: () => ({
        select: function () { return this; },
        eq: function () { return this; },
        maybeSingle: async () => ({ data: null, error: null }),
      }),
    };
    expect(await resolveOrgIdFromSlug(sb, 'non-existent')).toBeNull();
  });

  it('returns null when chain throws', async () => {
    const sb = { from: () => { throw new Error('db down'); } };
    expect(await resolveOrgIdFromSlug(sb, 'x')).toBeNull();
  });
});

describe('resolveAgentIdSafe (planner shell)', () => {
  it('returns the proactive_planner agent row id', async () => {
    const sb = makePlannerSupabase();
    expect(await resolveAgentIdSafe(sb, PLANNER_AGENT_SLUG, TEST_ORG_ID)).toBe(TEST_AGENT_ID);
  });
});

// ─── shell entry ───

describe('runAiPlannerShell — guard rails', () => {
  it('OPTIONS returns "ok"', async () => {
    const res = await runAiPlannerShell(
      new Request('https://x', { method: 'OPTIONS' }),
      { supabase: makePlannerSupabase(), apiKey: 'k' },
    );
    expect(res.status).toBe(200);
  });

  it('500 when ANTHROPIC_API_KEY missing', async () => {
    const res = await runAiPlannerShell(
      new Request('https://x', { method: 'POST', body: JSON.stringify({}) }),
      { supabase: makePlannerSupabase(), apiKey: undefined },
    );
    expect(res.status).toBe(500);
  });

  it('skips when planner_enabled=false', async () => {
    const sb = makePlannerSupabase({ enabled: false });
    const res = await runAiPlannerShell(
      new Request('https://x', { method: 'POST', body: JSON.stringify({}) }),
      { supabase: sb, apiKey: 'k' },
    );
    const body = await res.json();
    expect(body.results.skipped).toMatch(/disabled/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('skips when daily run already ran today (idempotent)', async () => {
    const sb = makePlannerSupabase({ lastRunDate: 'today' });
    const res = await runAiPlannerShell(
      new Request('https://x', { method: 'POST', body: JSON.stringify({}) }),
      { supabase: sb, apiKey: 'k' },
    );
    const body = await res.json();
    expect(body.results.skipped).toMatch(/already ran today/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('skips single-entity invocation when 30-min dedup hits', async () => {
    const sb = makePlannerSupabase({ recentTriggerExists: true });
    const res = await runAiPlannerShell(
      new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({ entity_id: 'cg-1', entity_type: 'caregiver', trigger_reason: 'test' }),
      }),
      { supabase: sb, apiKey: 'k' },
    );
    const body = await res.json();
    expect(body.results.skipped).toMatch(/already exists within 30 minutes/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('500 when org_id cannot be resolved', async () => {
    const sb = makePlannerSupabase({ orgRow: null });
    const res = await runAiPlannerShell(
      new Request('https://x', { method: 'POST', body: JSON.stringify({}) }),
      { supabase: sb, apiKey: 'k' },
    );
    const body = await res.json();
    expect(body.results.skipped).toMatch(/Could not resolve org_id/i);
  });
});

describe('runAiPlannerShell — runtime dispatch', () => {
  it('calls runAgent with shape="planner" and full_pipeline_daily mode', async () => {
    const sb = makePlannerSupabase();
    runAgent.mockImplementation(async () => ({
      status: 'ok',
      reply: JSON.stringify([]),
      cost: { input_tokens: 100, output_tokens: 50, iterations: 1, duration_ms: 0 },
      agent: { id: TEST_AGENT_ID, slug: PLANNER_AGENT_SLUG, version: 1 },
      shadow: false,
    }));

    await runAiPlannerShell(
      new Request('https://x', { method: 'POST', body: JSON.stringify({}) }),
      { supabase: sb, apiKey: 'k' },
    );

    expect(runAgent).toHaveBeenCalledOnce();
    const [, slug, request, options] = runAgent.mock.calls[0];
    expect(slug).toBe(PLANNER_AGENT_SLUG);
    expect(request.shape).toBe('planner');
    expect(request.planner.mode).toBe('full_pipeline_daily');
    expect(typeof request.planner.systemPrompt).toBe('string');
    expect(request.planner.systemPrompt).toMatch(/daily planner/i);
    expect(options.orgId).toBe(TEST_ORG_ID);
  });

  it('calls runAgent with single_entity_event_triggered mode for entity-scoped invocation', async () => {
    const sb = makePlannerSupabase();
    runAgent.mockImplementation(async () => ({
      status: 'ok',
      reply: JSON.stringify([]),
      cost: { input_tokens: 100, output_tokens: 50, iterations: 1, duration_ms: 0 },
      agent: { id: TEST_AGENT_ID, slug: PLANNER_AGENT_SLUG, version: 1 },
      shadow: false,
    }));

    await runAiPlannerShell(
      new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({ entity_id: 'cg-1', entity_type: 'caregiver', trigger_reason: 'x' }),
      }),
      { supabase: sb, apiKey: 'k' },
    );

    const [, , request] = runAgent.mock.calls[0];
    expect(request.planner.mode).toBe('single_entity_event_triggered');
  });
});

describe('runAiPlannerShell — agent_id stamping', () => {
  it('stamps agent_id on every ai_suggestions insert', async () => {
    const inserted = [];
    const sb = makePlannerSupabase({ insertedTracker: inserted });
    await runAiPlannerShell(
      new Request('https://x', { method: 'POST', body: JSON.stringify({}) }),
      { supabase: sb, apiKey: 'k' },
    );
    const suggestionInserts = inserted.filter(i => i.table === 'ai_suggestions');
    expect(suggestionInserts.length).toBeGreaterThan(0);
    for (const i of suggestionInserts) {
      expect(i.row.agent_id).toBe(TEST_AGENT_ID);
    }
  });

  it('omits agent_id when agents row lookup returns null (graceful)', async () => {
    const inserted = [];
    const sb = makePlannerSupabase({ agentRow: null, insertedTracker: inserted });
    await runAiPlannerShell(
      new Request('https://x', { method: 'POST', body: JSON.stringify({}) }),
      { supabase: sb, apiKey: 'k' },
    );
    const suggestionInserts = inserted.filter(i => i.table === 'ai_suggestions');
    expect(suggestionInserts.length).toBeGreaterThan(0);
    for (const i of suggestionInserts) {
      expect(i.row.agent_id).toBeUndefined();
    }
  });
});

describe('runAiPlannerShell — kill switch propagation', () => {
  it('reports skipped when runAgent returns status=killed', async () => {
    const sb = makePlannerSupabase();
    runAgent.mockImplementation(async () => ({
      status: 'killed',
      reply: 'Agent dormant',
      cost: { input_tokens: 0, output_tokens: 0, iterations: 0, duration_ms: 0 },
      agent: { id: TEST_AGENT_ID, slug: PLANNER_AGENT_SLUG, version: 1 },
      shadow: false,
    }));

    const res = await runAiPlannerShell(
      new Request('https://x', { method: 'POST', body: JSON.stringify({}) }),
      { supabase: sb, apiKey: 'k' },
    );
    const body = await res.json();
    expect(body.results.skipped).toMatch(/kill_switch/);
  });
});
