/**
 * Phase 1.4 — Aggregation helpers for the agent metrics dashboard.
 *
 * The aggregation layer is the single piece of business logic between
 * the raw `agent_actions` rows and the Recharts datasets, so we test it
 * thoroughly. Chart components are thin wrappers and don't merit unit
 * tests beyond a smoke render in the build.
 */

import { describe, it, expect } from 'vitest';

import {
  TIME_WINDOWS,
  getTimeWindow,
  PHASE_ORDER,
  PHASE_LABEL,
  aggregateTokenSpend,
  aggregateLatency,
  aggregateSuggestionVolume,
  aggregateVerifiedOutcomeRate,
  costPerVerifiedOutcome,
  totals,
} from '../../components/agentMetrics/metricsAggregation';

const MODEL_SONNET = 'claude-sonnet-4-5-20250929';
const MODEL_HAIKU = 'claude-haiku-4-5-20251001';

function action(overrides = {}) {
  return {
    id: 'a1',
    org_id: 'org-1',
    agent_id: 'ag-1',
    agent_version: 1,
    action_type: 'send_sms',
    phase: 'suggested',
    entity_type: 'caregiver',
    entity_id: 'cg-1',
    actor: 'system:test',
    payload: { _cost: { input_tokens: 100, output_tokens: 50, duration_ms: 1000, model: MODEL_SONNET } },
    outcome_id: null,
    created_at: '2026-05-12T10:00:00Z',
    ...overrides,
  };
}

describe('TIME_WINDOWS', () => {
  it('exposes day/week/30d windows in order', () => {
    expect(TIME_WINDOWS.map((w) => w.id)).toEqual(['day', 'week', 'month']);
  });

  it('getTimeWindow falls back to the week window for unknown ids', () => {
    expect(getTimeWindow('day').id).toBe('day');
    expect(getTimeWindow('nope').id).toBe('week');
  });
});

describe('PHASE_ORDER + PHASE_LABEL', () => {
  it('covers every phase enum value the spec mentions', () => {
    for (const ph of ['suggested', 'auto_executed', 'executed', 'confirmed', 'rejected', 'expired', 'shadow']) {
      expect(PHASE_ORDER.includes(ph)).toBe(true);
      expect(PHASE_LABEL[ph]).toBeTruthy();
    }
  });
});

describe('aggregateTokenSpend', () => {
  it('buckets tokens by day by default', () => {
    const rows = [
      action({ created_at: '2026-05-10T00:00:00Z', payload: { _cost: { input_tokens: 100, output_tokens: 50, duration_ms: 0, model: MODEL_SONNET } } }),
      action({ created_at: '2026-05-10T22:30:00Z', payload: { _cost: { input_tokens: 200, output_tokens: 100, duration_ms: 0, model: MODEL_SONNET } } }),
      action({ created_at: '2026-05-11T01:15:00Z', payload: { _cost: { input_tokens: 50, output_tokens: 25, duration_ms: 0, model: MODEL_SONNET } } }),
    ];
    const r = aggregateTokenSpend(rows);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ bucket: '2026-05-10', input_tokens: 300, output_tokens: 150 });
    expect(r[1]).toMatchObject({ bucket: '2026-05-11', input_tokens: 50, output_tokens: 25 });
  });

  it('buckets by hour when window=day', () => {
    const rows = [
      action({ created_at: '2026-05-12T10:00:00Z' }),
      action({ created_at: '2026-05-12T10:55:00Z' }),
      action({ created_at: '2026-05-12T11:01:00Z' }),
    ];
    const r = aggregateTokenSpend(rows, { bucket: 'hour' });
    expect(r).toHaveLength(2);
    expect(r[0].bucket).toBe('2026-05-12T10');
  });

  it('drops rows without _cost', () => {
    const rows = [
      action(),
      action({ id: 'a2', payload: {} }), // no _cost
    ];
    expect(aggregateTokenSpend(rows)).toHaveLength(1);
  });

  it('computes dollars from per-model pricing', () => {
    const rows = [
      // 1M input tokens of Sonnet @ $3 = $3
      action({ payload: { _cost: { input_tokens: 1_000_000, output_tokens: 0, duration_ms: 0, model: MODEL_SONNET } } }),
    ];
    expect(aggregateTokenSpend(rows)[0].dollars).toBeCloseTo(3.0, 4);
  });
});

describe('aggregateLatency', () => {
  it('averages duration_ms per bucket', () => {
    const rows = [
      action({ created_at: '2026-05-10T00:00:00Z', payload: { _cost: { duration_ms: 1000, input_tokens: 0, output_tokens: 0, model: MODEL_SONNET } } }),
      action({ created_at: '2026-05-10T01:00:00Z', payload: { _cost: { duration_ms: 3000, input_tokens: 0, output_tokens: 0, model: MODEL_SONNET } } }),
    ];
    const r = aggregateLatency(rows);
    expect(r).toHaveLength(1);
    expect(r[0].avg_ms).toBe(2000);
  });
});

describe('aggregateSuggestionVolume', () => {
  it('counts each phase and pads zero counts', () => {
    const rows = [
      action({ phase: 'suggested' }),
      action({ phase: 'suggested' }),
      action({ phase: 'auto_executed' }),
      action({ phase: 'rejected' }),
    ];
    const r = aggregateSuggestionVolume(rows);
    expect(r.find((p) => p.phase === 'suggested').count).toBe(2);
    expect(r.find((p) => p.phase === 'auto_executed').count).toBe(1);
    expect(r.find((p) => p.phase === 'executed').count).toBe(0);
    expect(r.length).toBe(PHASE_ORDER.length);
  });

  it('ignores unknown phases', () => {
    const rows = [action({ phase: 'made_up_phase' }), action({ phase: 'suggested' })];
    expect(aggregateSuggestionVolume(rows).reduce((acc, p) => acc + p.count, 0)).toBe(1);
  });
});

describe('aggregateVerifiedOutcomeRate', () => {
  it('joins by outcome_id and computes success rate per action_type', () => {
    const outcomes = [
      { id: 'o1', outcome_type: 'response_received' },
      { id: 'o2', outcome_type: 'no_response' },
      { id: 'o3', outcome_type: 'completed' },
      { id: 'o4', outcome_type: null }, // pending
    ];
    const rows = [
      action({ action_type: 'send_sms', outcome_id: 'o1' }), // success
      action({ action_type: 'send_sms', outcome_id: 'o2' }), // miss
      action({ action_type: 'send_email', outcome_id: 'o3' }), // success
      action({ action_type: 'send_email', outcome_id: 'o4' }), // pending
      action({ action_type: 'add_note', outcome_id: null }),   // no outcome row
    ];
    const r = aggregateVerifiedOutcomeRate(rows, outcomes);

    const sms = r.find((x) => x.action_type === 'send_sms');
    expect(sms).toMatchObject({ verified: 2, success: 1, pending: 0, total: 2 });
    expect(sms.success_rate).toBeCloseTo(0.5);

    const email = r.find((x) => x.action_type === 'send_email');
    expect(email).toMatchObject({ verified: 1, success: 1, pending: 1, total: 2 });

    const note = r.find((x) => x.action_type === 'add_note');
    expect(note.success_rate).toBeNull(); // no verified
  });

  it('handles empty outcomes safely', () => {
    const rows = [action({ action_type: 'send_sms' })];
    expect(aggregateVerifiedOutcomeRate(rows, []))
      .toEqual([{ action_type: 'send_sms', verified: 0, success: 0, pending: 1, total: 1, success_rate: null }]);
  });
});

describe('costPerVerifiedOutcome', () => {
  it('returns null cost_per when nothing is verified', () => {
    const r = costPerVerifiedOutcome([action()], []);
    expect(r.cost_per).toBeNull();
    expect(r.verified).toBe(0);
  });

  it('divides total dollars by total verified outcomes', () => {
    const outcomes = [{ id: 'o1', outcome_type: 'response_received' }];
    const rows = [
      action({ outcome_id: 'o1', payload: { _cost: { input_tokens: 1_000_000, output_tokens: 0, duration_ms: 0, model: MODEL_SONNET } } }),
    ];
    const r = costPerVerifiedOutcome(rows, outcomes);
    expect(r.dollars).toBeCloseTo(3.0, 4);
    expect(r.verified).toBe(1);
    expect(r.cost_per).toBeCloseTo(3.0, 4);
  });
});

describe('totals', () => {
  it('sums tokens and dollars across all rows that have _cost', () => {
    const rows = [
      action({ payload: { _cost: { input_tokens: 1_000_000, output_tokens: 1_000_000, duration_ms: 0, model: MODEL_SONNET } } }),
      action({ payload: { _cost: { input_tokens: 0, output_tokens: 0, duration_ms: 0, model: MODEL_HAIKU } } }),
      action({ payload: {} }), // no cost — counted in invocations_total only
    ];
    const t = totals(rows);
    expect(t.input_tokens).toBe(1_000_000);
    expect(t.output_tokens).toBe(1_000_000);
    expect(t.dollars).toBeCloseTo(3.0 + 15.0, 4); // 1M input @3 + 1M output @15
    expect(t.invocations_with_cost).toBe(2);
    expect(t.invocations_total).toBe(3);
  });
});
