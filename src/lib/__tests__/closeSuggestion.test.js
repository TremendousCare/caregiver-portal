/**
 * Phase 1.5 follow-up — closePendingSuggestion helper.
 *
 * The helper is the loop-closure pivot: it sits between every
 * operator-write surface (SMS, email, schedule, phase change, task
 * complete, note add) and the autonomy v2 algorithm. Each successful
 * operator action triggers a close that may write the `agent_actions`
 * row with `phase='executed'` that the algorithm reads as positive
 * signal.
 *
 * These tests cover:
 *   - Allowlist + input validation (never close on bad input).
 *   - No-match path (no pending suggestion → no-op, no audit row).
 *   - Match + close + audit (the happy path).
 *   - CAS race (another writer resolved the suggestion → no audit row).
 *   - Audit write failure (suggestion still closed, audit_failed=true).
 *   - Suggestion missing agent_id (legacy row → skip audit, still close).
 *
 * Vitest patterns mirror autonomyV2.test.js — chainable supabase mock,
 * captured insert/update/rpc args.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordAgentActionMock = vi.hoisted(() => vi.fn());
vi.mock(
  '../../../supabase/functions/_shared/operations/agentActions.ts',
  () => ({ recordAgentAction: recordAgentActionMock }),
);

import {
  closePendingSuggestion,
  CLOSEABLE_ACTION_TYPES,
} from '../../../supabase/functions/_shared/operations/closeSuggestion.ts';

const CAREGIVER_ID = 'cg-1';
const AGENT_ID = 'agent-recruiting-uuid';
const ORG_ID = '62fbaf9d-13ab-49f4-b92a-a774c67b69a6';

function makeSupabaseMock({
  suggestions = [],
  selectError = null,
  updatedRow = undefined, // undefined → echo first suggestion; null → CAS miss
  updateError = null,
  agentRow = { id: AGENT_ID, org_id: ORG_ID, version: 3 },
  agentError = null,
} = {}) {
  const updateCalls = [];

  const fromImpl = vi.fn((table) => {
    if (table === 'ai_suggestions') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  gt: vi.fn(() => ({
                    order: vi.fn(() => ({
                      limit: vi.fn(async () => ({
                        data: selectError ? null : suggestions,
                        error: selectError,
                      })),
                    })),
                  })),
                })),
              })),
            })),
          })),
        })),
        update: vi.fn((patch) => {
          updateCalls.push(patch);
          return {
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => {
                    if (updateError) return { data: null, error: updateError };
                    const echoed = updatedRow === undefined
                      ? (suggestions[0] || null)
                      : updatedRow;
                    return { data: echoed, error: null };
                  }),
                })),
              })),
            })),
          };
        }),
      };
    }
    if (table === 'agents') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: agentError ? null : agentRow,
              error: agentError,
            })),
          })),
        })),
      };
    }
    throw new Error(`unmocked table: ${table}`);
  });

  return { from: fromImpl, _updateCalls: updateCalls };
}

beforeEach(() => {
  recordAgentActionMock.mockReset();
  recordAgentActionMock.mockResolvedValue({ success: true, id: 'audit-row-uuid' });
});

describe('CLOSEABLE_ACTION_TYPES', () => {
  it('matches the action vocabulary the planner emits', () => {
    expect(CLOSEABLE_ACTION_TYPES).toContain('send_sms');
    expect(CLOSEABLE_ACTION_TYPES).toContain('send_email');
    expect(CLOSEABLE_ACTION_TYPES).toContain('add_note');
    expect(CLOSEABLE_ACTION_TYPES).toContain('complete_task');
    expect(CLOSEABLE_ACTION_TYPES).toContain('update_phase');
    expect(CLOSEABLE_ACTION_TYPES).toContain('create_calendar_event');
    expect(CLOSEABLE_ACTION_TYPES).toContain('send_docusign_envelope');
  });
});

describe('closePendingSuggestion — input validation', () => {
  it('rejects invalid entityType without touching supabase', async () => {
    const sb = makeSupabaseMock();
    const out = await closePendingSuggestion(sb, {
      entityType: 'invalid', entityId: CAREGIVER_ID, actionType: 'send_sms', actor: 'user:k',
    });
    expect(out.closed).toBe(false);
    expect(out.reason).toMatch(/invalid entity_type/);
    expect(sb.from).not.toHaveBeenCalled();
  });

  it('rejects missing entityId', async () => {
    const sb = makeSupabaseMock();
    const out = await closePendingSuggestion(sb, {
      entityType: 'caregiver', entityId: '', actionType: 'send_sms', actor: 'user:k',
    });
    expect(out.closed).toBe(false);
    expect(out.reason).toMatch(/invalid entity_id/);
  });

  it('rejects action_type not in the closeable allowlist', async () => {
    const sb = makeSupabaseMock();
    const out = await closePendingSuggestion(sb, {
      entityType: 'caregiver', entityId: CAREGIVER_ID, actionType: 'do_something_dangerous', actor: 'user:k',
    });
    expect(out.closed).toBe(false);
    expect(out.reason).toMatch(/closeable allowlist/);
  });

  it('rejects missing actor', async () => {
    const sb = makeSupabaseMock();
    const out = await closePendingSuggestion(sb, {
      entityType: 'caregiver', entityId: CAREGIVER_ID, actionType: 'send_sms', actor: '',
    });
    expect(out.closed).toBe(false);
    expect(out.reason).toMatch(/actor required/);
  });
});

describe('closePendingSuggestion — no-match path', () => {
  it('returns closed=false when no pending suggestion exists', async () => {
    const sb = makeSupabaseMock({ suggestions: [] });
    const out = await closePendingSuggestion(sb, {
      entityType: 'caregiver', entityId: CAREGIVER_ID, actionType: 'send_sms', actor: 'user:k',
    });
    expect(out.closed).toBe(false);
    expect(out.suggestion_id).toBeNull();
    expect(out.agent_action_id).toBeNull();
    expect(recordAgentActionMock).not.toHaveBeenCalled();
  });

  it('returns closed=false when the SELECT errors', async () => {
    const sb = makeSupabaseMock({ selectError: { message: 'boom' } });
    const out = await closePendingSuggestion(sb, {
      entityType: 'caregiver', entityId: CAREGIVER_ID, actionType: 'send_sms', actor: 'user:k',
    });
    expect(out.closed).toBe(false);
    expect(out.reason).toMatch(/select failed: boom/);
  });
});

describe('closePendingSuggestion — happy path', () => {
  it('closes suggestion, writes audit row, returns full result', async () => {
    const sug = { id: 'sug-1', agent_id: AGENT_ID, action_type: 'send_sms', status: 'pending' };
    const sb = makeSupabaseMock({ suggestions: [sug] });

    const out = await closePendingSuggestion(sb, {
      entityType: 'caregiver',
      entityId: CAREGIVER_ID,
      actionType: 'send_sms',
      actor: 'user:kevin@tc.com',
      params: { route_category: 'onboarding', char_count: 42 },
    });

    expect(out.closed).toBe(true);
    expect(out.suggestion_id).toBe('sug-1');
    expect(out.agent_action_id).toBe('audit-row-uuid');
    expect(out.audit_failed).toBe(false);

    // Suggestion status patched to executed with actor stamp.
    expect(sb._updateCalls[0].status).toBe('executed');
    expect(sb._updateCalls[0].resolved_by).toBe('user:kevin@tc.com');

    // Audit row content.
    expect(recordAgentActionMock).toHaveBeenCalledTimes(1);
    const audit = recordAgentActionMock.mock.calls[0][1];
    expect(audit.phase).toBe('executed');
    expect(audit.agentId).toBe(AGENT_ID);
    expect(audit.agentVersion).toBe(3);
    expect(audit.actionType).toBe('send_sms');
    expect(audit.entityType).toBe('caregiver');
    expect(audit.entityId).toBe(CAREGIVER_ID);
    expect(audit.actor).toBe('user:kevin@tc.com');
    expect(audit.payload.source).toBe('operator_action_loop_closure');
    expect(audit.payload.suggestion_id).toBe('sug-1');
    expect(audit.payload.params.route_category).toBe('onboarding');
    expect(audit.payload.params.char_count).toBe(42);
  });

  it('truncates long string params in the audit payload', async () => {
    const sug = { id: 'sug-1', agent_id: AGENT_ID, action_type: 'send_sms', status: 'pending' };
    const sb = makeSupabaseMock({ suggestions: [sug] });
    const longText = 'x'.repeat(500);

    await closePendingSuggestion(sb, {
      entityType: 'caregiver', entityId: CAREGIVER_ID, actionType: 'send_sms', actor: 'user:k',
      params: { body: longText },
    });

    const audit = recordAgentActionMock.mock.calls[0][1];
    expect(audit.payload.params.body.length).toBeLessThanOrEqual(200);
    expect(audit.payload.params.body.endsWith('...')).toBe(true);
  });

  it('flattens nested object params instead of inlining them', async () => {
    const sug = { id: 'sug-1', agent_id: AGENT_ID, action_type: 'send_sms', status: 'pending' };
    const sb = makeSupabaseMock({ suggestions: [sug] });

    await closePendingSuggestion(sb, {
      entityType: 'caregiver', entityId: CAREGIVER_ID, actionType: 'send_sms', actor: 'user:k',
      params: { nested: { a: 1, b: 2 }, arr: [1, 2, 3] },
    });

    const audit = recordAgentActionMock.mock.calls[0][1];
    expect(audit.payload.params.nested).toMatch(/\[object keys: a, b\]/);
    expect(audit.payload.params.arr).toMatch(/\[array length 3\]/);
  });
});

describe('closePendingSuggestion — race + failure paths', () => {
  it('returns closed=false on CAS miss (someone else resolved first)', async () => {
    const sug = { id: 'sug-1', agent_id: AGENT_ID, action_type: 'send_sms', status: 'pending' };
    const sb = makeSupabaseMock({ suggestions: [sug], updatedRow: null });

    const out = await closePendingSuggestion(sb, {
      entityType: 'caregiver', entityId: CAREGIVER_ID, actionType: 'send_sms', actor: 'user:k',
    });
    expect(out.closed).toBe(false);
    expect(out.reason).toMatch(/lost CAS race/);
    expect(recordAgentActionMock).not.toHaveBeenCalled();
  });

  it('marks audit_failed when the suggestion has no agent_id', async () => {
    const sug = { id: 'sug-1', agent_id: null, action_type: 'send_sms', status: 'pending' };
    const sb = makeSupabaseMock({
      suggestions: [sug],
      updatedRow: { id: 'sug-1', agent_id: null },
    });

    const out = await closePendingSuggestion(sb, {
      entityType: 'caregiver', entityId: CAREGIVER_ID, actionType: 'send_sms', actor: 'user:k',
    });
    expect(out.closed).toBe(true);
    expect(out.suggestion_id).toBe('sug-1');
    expect(out.audit_failed).toBe(true);
    expect(out.reason).toMatch(/no agent_id/);
    expect(recordAgentActionMock).not.toHaveBeenCalled();
  });

  it('marks audit_failed when the agent lookup fails', async () => {
    const sug = { id: 'sug-1', agent_id: AGENT_ID, action_type: 'send_sms', status: 'pending' };
    const sb = makeSupabaseMock({
      suggestions: [sug],
      agentError: { message: 'agent gone' },
    });

    const out = await closePendingSuggestion(sb, {
      entityType: 'caregiver', entityId: CAREGIVER_ID, actionType: 'send_sms', actor: 'user:k',
    });
    expect(out.closed).toBe(true);
    expect(out.audit_failed).toBe(true);
    expect(out.reason).toMatch(/agent lookup failed/);
  });

  it('marks audit_failed when recordAgentAction returns success=false', async () => {
    recordAgentActionMock.mockResolvedValueOnce({
      success: false,
      error: new Error('chain conflict'),
    });
    const sug = { id: 'sug-1', agent_id: AGENT_ID, action_type: 'send_sms', status: 'pending' };
    const sb = makeSupabaseMock({ suggestions: [sug] });

    const out = await closePendingSuggestion(sb, {
      entityType: 'caregiver', entityId: CAREGIVER_ID, actionType: 'send_sms', actor: 'user:k',
    });
    expect(out.closed).toBe(true);
    expect(out.suggestion_id).toBe('sug-1');
    expect(out.audit_failed).toBe(true);
    expect(out.reason).toMatch(/audit write failed: chain conflict/);
  });
});
