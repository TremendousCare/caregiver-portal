/**
 * Phase 1.4 — CSV export shape.
 *
 * Guards the column order and the per-row mapping so a future change to
 * the dashboard's data shape doesn't silently break the export the user
 * downloads.
 */

import { describe, it, expect } from 'vitest';

import { buildAgentActionsCsv } from '../../components/agentMetrics/csvExport';

const MODEL = 'claude-sonnet-4-5-20250929';

function row(overrides = {}) {
  return {
    id: 'a1',
    chain_seq: 7,
    action_type: 'send_sms',
    phase: 'executed',
    entity_type: 'caregiver',
    entity_id: 'cg-1',
    actor: 'user:Jessica',
    agent_version: 3,
    payload: { _cost: { input_tokens: 1000, output_tokens: 200, duration_ms: 1500, model: MODEL } },
    created_at: '2026-05-12T10:00:00Z',
    ...overrides,
  };
}

describe('buildAgentActionsCsv', () => {
  it('produces a header line + one row per action', () => {
    const csv = buildAgentActionsCsv([row(), row({ id: 'a2', chain_seq: 8 })], []);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('created_at');
    expect(lines[0]).toContain('chain_seq');
    expect(lines[0]).toContain('dollars');
    expect(lines[0]).toContain('outcome_detected_at');
    expect(lines[0]).not.toContain('outcome_id'); // dropped per Codex P1
  });

  it('correlates an outcome via natural key + ±10min window', () => {
    // send_sms (verb) maps to sms_sent (past tense) on the outcome side.
    const csv = buildAgentActionsCsv(
      [row()],
      [{
        action_type: 'sms_sent',
        entity_id: 'cg-1',
        outcome_type: 'response_received',
        outcome_detected_at: '2026-05-12T11:00:00Z',
        created_at: '2026-05-12T10:02:00Z', // within 10min of action's 10:00
      }],
    );
    const dataLine = csv.split('\n')[1];
    expect(dataLine).toContain('response_received');
    expect(dataLine).toContain('2026-05-12T11:00:00Z');
  });

  it('writes empty cells when outcome missing or outside the ±10min window', () => {
    const csv = buildAgentActionsCsv(
      [row()],
      [{
        action_type: 'sms_sent',
        entity_id: 'cg-1',
        outcome_type: 'response_received',
        created_at: '2026-05-12T13:00:00Z', // 3h after action — outside window
      }],
    );
    const dataLine = csv.split('\n')[1];
    expect(dataLine.endsWith(',,')).toBe(true);
  });

  it('does not correlate across different entities', () => {
    const csv = buildAgentActionsCsv(
      [row()],
      [{
        action_type: 'sms_sent',
        entity_id: 'cg-OTHER',
        outcome_type: 'response_received',
        created_at: '2026-05-12T10:01:00Z',
      }],
    );
    const dataLine = csv.split('\n')[1];
    expect(dataLine.endsWith(',,')).toBe(true);
  });

  it('escapes commas and quotes in cell values', () => {
    const csv = buildAgentActionsCsv([row({ actor: 'user:O\'Brien, Sam', entity_id: 'with "quotes"' })], []);
    const dataLine = csv.split('\n')[1];
    expect(dataLine).toContain('"user:O\'Brien, Sam"');
    expect(dataLine).toContain('"with ""quotes"""');
  });

  it('handles rows without _cost gracefully (writes blanks not NaN)', () => {
    const csv = buildAgentActionsCsv([row({ payload: {} })], []);
    const dataLine = csv.split('\n')[1];
    expect(dataLine).not.toContain('NaN');
    expect(dataLine).not.toContain('undefined');
  });

  it('computes per-row dollars from model pricing', () => {
    const csv = buildAgentActionsCsv(
      [row({ payload: { _cost: { input_tokens: 1_000_000, output_tokens: 0, duration_ms: 0, model: MODEL } } })],
      [],
    );
    const dataLine = csv.split('\n')[1];
    // 1M Sonnet input @ $3 = $3.000000
    expect(dataLine).toMatch(/,3\.000000,/);
  });
});
