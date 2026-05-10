/**
 * Phase 1.2 — recordAutonomyOutcome ↔ recordAutonomyOutcomeV2 wiring.
 *
 * The shared helper `recordAutonomyOutcome` keeps the legacy
 * `autonomy_config` consecutive-counter path running unchanged AND fires
 * the new v2 evaluator (per-(agent × action) profile) when the caller
 * passes an `agentId`.
 *
 * Goal: prove the two paths are wired together without regressing the
 * legacy contract. We mock the autonomy_config row, intercept the
 * dynamic import of `autonomy.ts`, and check both:
 *   1. Legacy autonomy_config path UPDATEs as before (back-compat).
 *   2. v2 path fires only when agentId is supplied.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { recordAutonomyOutcome }
  from '../../../supabase/functions/_shared/operations/routing.ts';

const AGENT_ID = 'agent-recruiting-uuid';

function makeLegacySupabase() {
  const updates = [];
  return {
    from: vi.fn((table) => {
      if (table === 'autonomy_config') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: {
                      id: 'cfg-1',
                      action_type: 'send_sms',
                      entity_type: 'caregiver',
                      context: 'inbound_routing',
                      autonomy_level: 'L1',
                      consecutive_approvals: 4,
                      total_approvals: 4,
                      total_rejections: 0,
                      auto_promote_threshold: 10,
                      auto_demote_on_reject: true,
                      max_autonomy_level: 'L3',
                    },
                    error: null,
                  })),
                })),
              })),
            })),
          })),
          update: vi.fn((row) => {
            updates.push(row);
            return {
              eq: vi.fn(async () => ({ error: null })),
            };
          }),
        };
      }
      // v2 path reads agents + agent_actions, writes via the
      // `update_autonomy_profile_entry_v1` RPC, and inserts events. We
      // don't verify those here (autonomyV2.test.js owns that contract).
      // Return a no-op stub for any table the v2 wrapper touches so it
      // doesn't throw.
      if (table === 'agents') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: {
                  id: AGENT_ID,
                  org_id: 'org-1',
                  version: 1,
                  autonomy_profile: { send_sms: { current_level: 'L1' } },
                },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'agent_actions') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn(async () => ({ data: [], error: null })),
                })),
              })),
            })),
          })),
        };
      }
      if (table === 'events') {
        return { insert: vi.fn(async () => ({ error: null })) };
      }
      throw new Error(`unmocked table: ${table}`);
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    _legacyUpdates: updates,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordAutonomyOutcome — legacy path (back-compat)', () => {
  it('updates autonomy_config on approval without an agentId (no v2)', async () => {
    const sb = makeLegacySupabase();
    const result = await recordAutonomyOutcome(
      sb,
      'send_sms',
      'caregiver',
      'inbound_routing',
      true,
    );
    expect(result.newLevel).toBe('L1');
    expect(sb._legacyUpdates.length).toBe(1);
    expect(sb._legacyUpdates[0].consecutive_approvals).toBe(5);
    expect(sb._legacyUpdates[0].total_approvals).toBe(5);
  });

  it('updates autonomy_config on rejection without an agentId (no v2)', async () => {
    const sb = makeLegacySupabase();
    const result = await recordAutonomyOutcome(
      sb,
      'send_sms',
      'caregiver',
      'inbound_routing',
      false,
    );
    expect(result.newLevel).toBe('L1');
    expect(sb._legacyUpdates.length).toBe(1);
    expect(sb._legacyUpdates[0].consecutive_approvals).toBe(0);
    expect(sb._legacyUpdates[0].total_rejections).toBe(1);
  });
});

describe('recordAutonomyOutcome — v2 wiring', () => {
  it('does not call the agents table when no agentId supplied', async () => {
    const sb = makeLegacySupabase();
    await recordAutonomyOutcome(sb, 'send_sms', 'caregiver', 'inbound_routing', true);
    // Inspect the from() mock call list — agents must not appear.
    const tables = sb.from.mock.calls.map((c) => c[0]);
    expect(tables).toContain('autonomy_config');
    expect(tables).not.toContain('agents');
    expect(tables).not.toContain('agent_actions');
    expect(tables).not.toContain('events');
  });

  it('triggers v2 path (touches agents + agent_actions) when agentId supplied', async () => {
    const sb = makeLegacySupabase();
    await recordAutonomyOutcome(
      sb,
      'send_sms',
      'caregiver',
      'inbound_routing',
      true,
      { agentId: AGENT_ID, latestPhase: 'executed' },
    );
    // Wait one microtask cycle for the dynamic import + fire-and-forget v2 path.
    await new Promise((r) => setTimeout(r, 30));
    const tables = sb.from.mock.calls.map((c) => c[0]);
    expect(tables).toContain('autonomy_config'); // legacy still ran
    expect(tables).toContain('agents');          // v2 ran too
    expect(tables).toContain('agent_actions');
  });

  it('returns the legacy verdict shape regardless of v2 outcome', async () => {
    const sb = makeLegacySupabase();
    const result = await recordAutonomyOutcome(
      sb,
      'send_sms',
      'caregiver',
      'inbound_routing',
      true,
      { agentId: AGENT_ID, latestPhase: 'executed' },
    );
    // Legacy callers read newLevel/promoted/demoted; v2 must not change
    // that contract.
    expect(result).toMatchObject({
      newLevel: expect.any(String),
      promoted: expect.any(Boolean),
      demoted: expect.any(Boolean),
    });
  });
});
