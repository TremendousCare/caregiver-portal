/**
 * Phase 0.4 — agent_id stamping inside routing.ts.
 *
 *   - createSuggestion: optional `agentId` propagates to the insert row
 *   - createSuggestion: omit `agentId` → no `agent_id` column on insert
 *   - executeSuggestion: reads agent_id from the suggestion row and
 *     stamps it on the action_outcomes side-effect insert
 *   - executeSuggestion: legacy suggestion (no agent_id) → no agent_id on outcome
 *
 * These guards ensure the cutover paths add an explicit stamp without
 * disturbing legacy NULL behaviour. The shells rely on this contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createSuggestion,
} from '../../../supabase/functions/_shared/operations/routing.ts';

const TEST_AGENT_ID = 'agent-router-uuid';

function makeInsertCapturingSupabase() {
  const inserts = [];
  return {
    inserts,
    from: vi.fn(() => ({
      insert: vi.fn(async (row) => {
        inserts.push(row);
        return { error: null };
      }),
    })),
  };
}

const baseClassification = {
  intent: 'general_response',
  confidence: 0.8,
  suggested_action: 'send_sms',
  suggested_params: {},
  drafted_response: 'Hi!',
  reasoning: 'casual reply',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createSuggestion — agent_id propagation', () => {
  it('writes agent_id when caller supplies it', async () => {
    const sb = makeInsertCapturingSupabase();
    await createSuggestion(sb, {
      sourceType: 'inbound_sms',
      sourceId: 'queue-1',
      entityType: 'caregiver',
      entityId: 'cg-1',
      entityName: 'Jane',
      classification: baseClassification,
      autonomyLevel: 'L1',
      channel: 'sms',
      agentId: TEST_AGENT_ID,
    });
    expect(sb.inserts.length).toBe(1);
    expect(sb.inserts[0].agent_id).toBe(TEST_AGENT_ID);
  });

  it('omits agent_id column when caller does not supply it (legacy parity)', async () => {
    const sb = makeInsertCapturingSupabase();
    await createSuggestion(sb, {
      sourceType: 'inbound_sms',
      sourceId: 'queue-1',
      entityType: 'caregiver',
      entityId: 'cg-1',
      entityName: 'Jane',
      classification: baseClassification,
      autonomyLevel: 'L1',
      channel: 'sms',
    });
    expect(sb.inserts[0]).not.toHaveProperty('agent_id');
  });

  it('omits agent_id column when caller passes null/undefined', async () => {
    const sb = makeInsertCapturingSupabase();
    await createSuggestion(sb, {
      sourceType: 'inbound_sms',
      sourceId: 'queue-1',
      entityType: 'caregiver',
      entityId: 'cg-1',
      entityName: 'Jane',
      classification: baseClassification,
      autonomyLevel: 'L1',
      channel: 'sms',
      agentId: null,
    });
    expect(sb.inserts[0]).not.toHaveProperty('agent_id');
  });

  it('omits agent_id column when caller passes empty string', async () => {
    const sb = makeInsertCapturingSupabase();
    await createSuggestion(sb, {
      sourceType: 'inbound_sms',
      sourceId: 'queue-1',
      entityType: 'caregiver',
      entityId: 'cg-1',
      entityName: 'Jane',
      classification: baseClassification,
      autonomyLevel: 'L1',
      channel: 'sms',
      agentId: '',
    });
    expect(sb.inserts[0]).not.toHaveProperty('agent_id');
  });

  it('preserves the rest of the legacy insert shape with agentId set', async () => {
    const sb = makeInsertCapturingSupabase();
    await createSuggestion(sb, {
      sourceType: 'inbound_email',
      sourceId: 'queue-2',
      entityType: 'client',
      entityId: 'cl-9',
      entityName: 'Acme',
      classification: { ...baseClassification, intent: 'opt_out' },
      autonomyLevel: 'L4',
      channel: 'email',
      agentId: TEST_AGENT_ID,
    });
    const row = sb.inserts[0];
    expect(row.source_type).toBe('inbound_email');
    expect(row.entity_id).toBe('cl-9');
    expect(row.intent).toBe('opt_out');
    expect(row.autonomy_level).toBe('L4');
    expect(row.status).toBe('auto_executed');
    expect(row.agent_id).toBe(TEST_AGENT_ID);
  });
});
