/**
 * Phase 1.6.2 — persistCallAnalysis write helper.
 *
 * The runtime returns a parsed analysis blob; this helper writes it
 * atomically (ai_suggestions rows + agent_actions audit rows +
 * call_sessions.ai_summary stamp). These tests pin:
 *
 *   * Action items map to one ai_suggestions row each.
 *   * suggested_phase_change becomes one extra ai_suggestions row.
 *   * agent_actions audit rows get phase='shadow' when shadow_mode=true.
 *   * call_sessions.ai_summary stamped LAST (idempotency anchor).
 *   * memory_candidates land in ai_outcome.memory_candidates_draft;
 *     no context_memory rows written.
 *   * Partial-write failures collect into errors[] and don't poison
 *     the stamp.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordAgentActionMock = vi.hoisted(() => vi.fn());
vi.mock(
  '../../../supabase/functions/_shared/operations/agentActions.ts',
  () => ({ recordAgentAction: recordAgentActionMock }),
);

import { persistCallAnalysis } from '../../../supabase/functions/_shared/operations/agentRuntime/persistCallAnalysis.ts';

const ORG_ID  = '62fbaf9d-13ab-49f4-b92a-a774c67b69a6';
const AGENT_ID = 'agent-call-analyst-uuid';

function makeSupabaseMock({
  insertResult = { data: [], error: null },
  updateResult = { error: null },
} = {}) {
  const insertCalls = [];
  const updateCalls = [];
  const fromImpl = vi.fn((table) => {
    if (table === 'ai_suggestions') {
      return {
        insert: vi.fn((rows) => {
          insertCalls.push(rows);
          return {
            select: vi.fn(async () => insertResult),
          };
        }),
      };
    }
    if (table === 'call_sessions') {
      return {
        update: vi.fn((payload) => {
          updateCalls.push(payload);
          return {
            eq: vi.fn(async () => updateResult),
          };
        }),
      };
    }
    return {};
  });
  return { from: fromImpl, _insertCalls: insertCalls, _updateCalls: updateCalls };
}

const SAMPLE_ANALYSIS = {
  call_type: 'recruiting',
  summary:   'Maria confirmed availability for Thursday.',
  sentiment: 'positive',
  red_flags: ['compliance_concern'],
  action_items: [
    { title: 'Send orientation packet',  detail: 'Confirm receipt by Tuesday.', priority: 'high' },
    { title: 'Schedule follow-up call',  detail: 'Day after orientation.',       priority: 'medium' },
  ],
  memory_candidates: [
    { content: 'Prefers morning shifts.', confidence: 0.85, tags: ['preference'] },
  ],
  suggested_phase_change: { to_phase: 'onboarding', rationale: 'Ready to proceed.' },
};

const BASE_INPUT = {
  callSessionId:    'cs-1',
  orgId:            ORG_ID,
  matchedEntityType: 'caregiver',
  matchedEntityId:   'cg-1',
  agentId:           AGENT_ID,
  agentVersion:      1,
  shadowMode:        false,
  analysis:          SAMPLE_ANALYSIS,
};

beforeEach(() => {
  recordAgentActionMock.mockReset();
});

describe('persistCallAnalysis — happy path', () => {
  it('writes one ai_suggestions row per action_item plus one for the phase change', async () => {
    const insertedRows = [
      { id: 'sug-1', action_type: 'task_create',  entity_type: 'caregiver', entity_id: 'cg-1' },
      { id: 'sug-2', action_type: 'task_create',  entity_type: 'caregiver', entity_id: 'cg-1' },
      { id: 'sug-3', action_type: 'update_phase', entity_type: 'caregiver', entity_id: 'cg-1' },
    ];
    const sb = makeSupabaseMock({
      insertResult: { data: insertedRows, error: null },
    });
    recordAgentActionMock.mockResolvedValue({ success: true, id: 'audit-1' });

    const out = await persistCallAnalysis(sb, BASE_INPUT);

    expect(out.suggestionsWritten).toBe(3);
    expect(out.auditRowsWritten).toBe(3);
    expect(out.callSessionUpdated).toBe(true);
    expect(out.errors).toEqual([]);
    // Verify the rows passed to insert.
    const inserted = sb._insertCalls[0];
    expect(inserted).toHaveLength(3);
    expect(inserted[0].source_type).toBe('call_analyst');
    expect(inserted[0].action_type).toBe('task_create');
    expect(inserted[0].autonomy_level).toBe('L1');
    expect(inserted[0].status).toBe('pending');
    expect(inserted[0].agent_id).toBe(AGENT_ID);
    expect(inserted[0].action_params.call_session_id).toBe('cs-1');
    expect(inserted[2].action_type).toBe('update_phase');
    expect(inserted[2].action_params.new_phase).toBe('onboarding');
  });

  it('uses update_client_phase when matched_entity_type=client', async () => {
    const sb = makeSupabaseMock({
      insertResult: { data: [{ id: 'sug-1', action_type: 'update_client_phase', entity_type: 'client', entity_id: 'cl-1' }], error: null },
    });
    recordAgentActionMock.mockResolvedValue({ success: true, id: 'audit-1' });

    await persistCallAnalysis(sb, {
      ...BASE_INPUT,
      matchedEntityType: 'client',
      matchedEntityId:   'cl-1',
      analysis: {
        ...SAMPLE_ANALYSIS,
        action_items:           [],
        suggested_phase_change: { to_phase: 'won', rationale: 'Signed today.' },
      },
    });
    const inserted = sb._insertCalls[0];
    expect(inserted).toHaveLength(1);
    expect(inserted[0].action_type).toBe('update_client_phase');
    expect(inserted[0].entity_type).toBe('client');
  });

  it('stamps call_sessions.ai_summary + ai_outcome correctly', async () => {
    const sb = makeSupabaseMock({
      insertResult: { data: [{ id: 'sug-1', action_type: 'task_create', entity_type: 'caregiver', entity_id: 'cg-1' }], error: null },
    });
    recordAgentActionMock.mockResolvedValue({ success: true });

    await persistCallAnalysis(sb, BASE_INPUT);
    const update = sb._updateCalls[0];
    expect(update.ai_summary).toBe('Maria confirmed availability for Thursday.');
    expect(update.ai_outcome.call_type).toBe('recruiting');
    expect(update.ai_outcome.sentiment).toBe('positive');
    expect(update.ai_outcome.red_flags).toEqual(['compliance_concern']);
    expect(update.ai_outcome.memory_candidates_draft).toEqual(SAMPLE_ANALYSIS.memory_candidates);
    expect(update.ai_outcome.analyzed_by_agent_id).toBe(AGENT_ID);
    expect(update.ai_outcome.analyzed_in_shadow_mode).toBe(false);
    expect(typeof update.ai_outcome.analyzed_at).toBe('string');
  });
});

describe('persistCallAnalysis — _cost capture', () => {
  it('prorates the analysis-call cost across audit rows and stamps payload._cost', async () => {
    const insertedRows = [
      { id: 'sug-1', action_type: 'task_create',  entity_type: 'caregiver', entity_id: 'cg-1' },
      { id: 'sug-2', action_type: 'task_create',  entity_type: 'caregiver', entity_id: 'cg-1' },
      { id: 'sug-3', action_type: 'update_phase', entity_type: 'caregiver', entity_id: 'cg-1' },
    ];
    const sb = makeSupabaseMock({ insertResult: { data: insertedRows, error: null } });
    recordAgentActionMock.mockResolvedValue({ success: true });

    await persistCallAnalysis(sb, {
      ...BASE_INPUT,
      cost: { input_tokens: 900, output_tokens: 300, duration_ms: 4200, model: 'claude-sonnet-4-6' },
    });

    // Three suggestions → cost divided by 3, duration + model shared.
    for (const call of recordAgentActionMock.mock.calls) {
      expect(call[1].payload._cost).toEqual({
        input_tokens: 300,
        output_tokens: 100,
        duration_ms: 4200,
        model: 'claude-sonnet-4-6',
      });
    }
  });

  it('omits _cost entirely when no cost is supplied', async () => {
    const sb = makeSupabaseMock({
      insertResult: { data: [{ id: 'sug-1', action_type: 'task_create', entity_type: 'caregiver', entity_id: 'cg-1' }], error: null },
    });
    recordAgentActionMock.mockResolvedValue({ success: true });

    await persistCallAnalysis(sb, BASE_INPUT);
    expect(recordAgentActionMock.mock.calls[0][1].payload).not.toHaveProperty('_cost');
  });
});

describe('persistCallAnalysis — shadow mode', () => {
  it('stamps each agent_actions audit row with phase=shadow', async () => {
    const sb = makeSupabaseMock({
      insertResult: { data: [{ id: 'sug-1', action_type: 'task_create', entity_type: 'caregiver', entity_id: 'cg-1' }], error: null },
    });
    recordAgentActionMock.mockResolvedValue({ success: true });

    await persistCallAnalysis(sb, { ...BASE_INPUT, shadowMode: true });
    const auditCall = recordAgentActionMock.mock.calls[0][1];
    expect(auditCall.phase).toBe('shadow');
    expect(auditCall.actor).toBe('system:call_analyst');
    expect(auditCall.payload.source).toBe('call_analyst_extraction');
    expect(auditCall.payload.call_session_id).toBe('cs-1');
  });

  it('also stamps ai_outcome.analyzed_in_shadow_mode=true', async () => {
    const sb = makeSupabaseMock({
      insertResult: { data: [{ id: 'sug-1', action_type: 'task_create', entity_type: 'caregiver', entity_id: 'cg-1' }], error: null },
    });
    recordAgentActionMock.mockResolvedValue({ success: true });

    await persistCallAnalysis(sb, { ...BASE_INPUT, shadowMode: true });
    expect(sb._updateCalls[0].ai_outcome.analyzed_in_shadow_mode).toBe(true);
  });
});

describe('persistCallAnalysis — empty analyses', () => {
  it('still stamps call_sessions when there are zero action items + no phase change', async () => {
    const sb = makeSupabaseMock({
      insertResult: { data: [], error: null },
    });

    const out = await persistCallAnalysis(sb, {
      ...BASE_INPUT,
      analysis: {
        ...SAMPLE_ANALYSIS,
        action_items:           [],
        suggested_phase_change: null,
      },
    });
    expect(out.suggestionsWritten).toBe(0);
    expect(out.auditRowsWritten).toBe(0);
    expect(out.callSessionUpdated).toBe(true);
    // No insert call should have been made because there were no rows to insert.
    expect(sb._insertCalls.length).toBe(0);
    // But the update call IS made.
    expect(sb._updateCalls.length).toBe(1);
  });
});

describe('persistCallAnalysis — partial failure', () => {
  it('collects ai_suggestions insert errors into errors[] but still stamps the call', async () => {
    const sb = makeSupabaseMock({
      insertResult: { data: null, error: { message: 'rls denied' } },
      updateResult: { error: null },
    });

    const out = await persistCallAnalysis(sb, BASE_INPUT);
    expect(out.suggestionsWritten).toBe(0);
    expect(out.callSessionUpdated).toBe(true);
    expect(out.errors[0]).toMatchObject({ step: 'insert_ai_suggestions', message: 'rls denied' });
  });

  it('collects agent_actions failure but keeps the suggestion + stamp', async () => {
    const sb = makeSupabaseMock({
      insertResult: { data: [{ id: 'sug-1', action_type: 'task_create', entity_type: 'caregiver', entity_id: 'cg-1' }], error: null },
    });
    recordAgentActionMock.mockResolvedValue({ success: false, error: new Error('audit fail') });

    const out = await persistCallAnalysis(sb, BASE_INPUT);
    expect(out.suggestionsWritten).toBe(1);
    expect(out.auditRowsWritten).toBe(0);
    expect(out.callSessionUpdated).toBe(true);
    expect(out.errors[0]).toMatchObject({ step: 'record_agent_action', message: 'audit fail' });
  });

  it('collects call_sessions update error', async () => {
    const sb = makeSupabaseMock({
      insertResult: { data: [{ id: 'sug-1', action_type: 'task_create', entity_type: 'caregiver', entity_id: 'cg-1' }], error: null },
      updateResult: { error: { message: 'update failed' } },
    });
    recordAgentActionMock.mockResolvedValue({ success: true });

    const out = await persistCallAnalysis(sb, BASE_INPUT);
    expect(out.callSessionUpdated).toBe(false);
    expect(out.errors.some((e) => e.step === 'update_call_sessions')).toBe(true);
  });
});
