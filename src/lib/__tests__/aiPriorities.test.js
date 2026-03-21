/**
 * Tests for AI Priorities — pure logic for dashboard priorities
 * and profile recommendation cards (Phase 4C Chunk 1).
 */

import { describe, it, expect } from 'vitest';
import {
  buildPriorityItems,
  getRecommendation,
  computeStaleCaregivers,
  getLastActivityTimestamp,
} from '../aiPriorities';

const NOW = Date.now();
const DAYS = 86400000;

// ─── Test fixtures ───

function makeCg(overrides = {}) {
  return {
    id: 'cg_1',
    first_name: 'Maria',
    last_name: 'Garcia',
    phone: '555-1234',
    email: 'maria@example.com',
    created_at: new Date(NOW - 10 * DAYS).toISOString(),
    archived: false,
    board_status: null,
    notes: [
      { text: 'Called', type: 'call', timestamp: NOW - 1 * DAYS },
    ],
    tasks: {
      task_tb: { completed: false },
      task_i9: { completed: true, completedAt: NOW - DAYS },
    },
    ...overrides,
  };
}

function makeSuggestion(overrides = {}) {
  return {
    id: 'sug_abc',
    entity_id: 'cg_1',
    entity_name: 'Maria Garcia',
    action_type: 'send_sms',
    title: '[HIGH] Send follow-up SMS',
    detail: 'No response in 5 days',
    drafted_content: 'Hi Maria, just checking in!',
    status: 'pending',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── getLastActivityTimestamp ───

describe('getLastActivityTimestamp', () => {
  it('returns max note timestamp', () => {
    const cg = makeCg({ notes: [
      { text: 'old', timestamp: NOW - 5 * DAYS },
      { text: 'new', timestamp: NOW - 1 * DAYS },
    ]});
    expect(getLastActivityTimestamp(cg)).toBe(NOW - 1 * DAYS);
  });

  it('falls back to created_at when no notes', () => {
    const created = new Date(NOW - 10 * DAYS).toISOString();
    const cg = makeCg({ notes: [], created_at: created });
    expect(getLastActivityTimestamp(cg)).toBe(new Date(created).getTime());
  });

  it('handles string timestamps in notes', () => {
    const ts = new Date(NOW - 2 * DAYS).toISOString();
    const cg = makeCg({ notes: [{ text: 'x', timestamp: ts }] });
    expect(getLastActivityTimestamp(cg)).toBe(new Date(ts).getTime());
  });

  it('skips string notes (legacy format)', () => {
    const cg = makeCg({ notes: ['some string note'] });
    // Should fall back to created_at
    expect(getLastActivityTimestamp(cg)).toBe(new Date(cg.created_at).getTime());
  });

  it('returns 0 for null caregiver', () => {
    expect(getLastActivityTimestamp(null)).toBe(0);
  });
});

// ─── computeStaleCaregivers ───

describe('computeStaleCaregivers', () => {
  it('identifies caregivers with no activity for 3+ days', () => {
    const cg = makeCg({ notes: [{ text: 'old', timestamp: NOW - 5 * DAYS }] });
    const result = computeStaleCaregivers([cg], 3);
    expect(result.length).toBe(1);
    expect(result[0].daysSinceActivity).toBe(5);
  });

  it('excludes caregivers with recent activity', () => {
    const cg = makeCg({ notes: [{ text: 'recent', timestamp: NOW - 1 * DAYS }] });
    const result = computeStaleCaregivers([cg], 3);
    expect(result.length).toBe(0);
  });

  it('skips archived caregivers', () => {
    const cg = makeCg({ archived: true, notes: [{ text: 'old', timestamp: NOW - 10 * DAYS }] });
    const result = computeStaleCaregivers([cg], 3);
    expect(result.length).toBe(0);
  });

  it('skips deployed caregivers', () => {
    const cg = makeCg({ board_status: 'deployed', notes: [{ text: 'old', timestamp: NOW - 10 * DAYS }] });
    const result = computeStaleCaregivers([cg], 3);
    expect(result.length).toBe(0);
  });

  it('skips caregivers with no name (test/incomplete data)', () => {
    const cg = makeCg({ first_name: null, last_name: null, notes: [{ text: 'old', timestamp: NOW - 10 * DAYS }] });
    const result = computeStaleCaregivers([cg], 3);
    expect(result.length).toBe(0);
  });

  it('returns empty array for null input', () => {
    expect(computeStaleCaregivers(null)).toEqual([]);
  });
});

// ─── buildPriorityItems ───

describe('buildPriorityItems', () => {
  it('returns empty array when no suggestions and no stale caregivers', () => {
    const cg = makeCg(); // recent activity
    expect(buildPriorityItems([], [cg])).toEqual([]);
  });

  it('includes pending AI suggestions', () => {
    const sug = makeSuggestion();
    const result = buildPriorityItems([sug], []);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('suggestion');
    expect(result[0].title).toBe('Send follow-up SMS');
    expect(result[0].entityId).toBe('cg_1');
  });

  it('includes stale caregivers', () => {
    const cg = makeCg({ id: 'cg_stale', notes: [{ text: 'old', timestamp: NOW - 5 * DAYS }] });
    const result = buildPriorityItems([], [cg]);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('stale');
    expect(result[0].entityId).toBe('cg_stale');
  });

  it('sorts by urgency (critical first)', () => {
    const sugHigh = makeSuggestion({ id: 'h', title: '[HIGH] Urgent' });
    const sugLow = makeSuggestion({ id: 'l', entity_id: 'cg_2', title: '[LOW] Low priority' });
    const result = buildPriorityItems([sugLow, sugHigh], []);
    expect(result[0].urgency).toBe('critical');
    expect(result[1].urgency).toBe('info');
  });

  it('caps at 5 items', () => {
    const suggestions = Array.from({ length: 10 }, (_, i) =>
      makeSuggestion({ id: `s${i}`, entity_id: `cg_${i}`, title: `[MEDIUM] Item ${i}` })
    );
    const result = buildPriorityItems(suggestions, []);
    expect(result.length).toBe(5);
  });

  it('deduplicates entity appearing in both suggestions and stale list', () => {
    const sug = makeSuggestion({ entity_id: 'cg_dup' });
    const cg = makeCg({ id: 'cg_dup', notes: [{ text: 'old', timestamp: NOW - 5 * DAYS }] });
    const result = buildPriorityItems([sug], [cg]);
    // Should only appear once (as suggestion, not stale)
    const dupItems = result.filter(i => i.entityId === 'cg_dup');
    expect(dupItems.length).toBe(1);
    expect(dupItems[0].type).toBe('suggestion');
  });
});

// ─── getRecommendation ───

describe('getRecommendation', () => {
  it('uses AI suggestion when available', () => {
    const sug = makeSuggestion();
    const result = getRecommendation(sug, makeCg());
    expect(result.source).toBe('ai');
    expect(result.title).toBe('Send follow-up SMS');
    expect(result.ctaLabel).toBe('Send SMS');
  });

  it('falls back to stale heuristic when no suggestion and 3+ days inactive', () => {
    const cg = makeCg({ notes: [{ text: 'old', timestamp: NOW - 5 * DAYS }] });
    const result = getRecommendation(null, cg);
    expect(result.source).toBe('heuristic');
    expect(result.title).toBe('Consider sending a follow-up');
    expect(result.reason).toContain('5 days');
  });

  it('falls back to "all tasks complete" heuristic', () => {
    const cg = makeCg({
      tasks: { task_a: { completed: true }, task_b: { completed: true } },
    });
    const result = getRecommendation(null, cg);
    expect(result.source).toBe('heuristic');
    expect(result.title).toBe('Ready for next phase');
  });

  it('returns "on track" when nothing actionable', () => {
    const cg = makeCg(); // recent activity, incomplete tasks
    const result = getRecommendation(null, cg);
    expect(result.source).toBe('heuristic');
    expect(result.title).toBe('On track');
  });

  it('suggests email when no phone and stale', () => {
    const cg = makeCg({ phone: null, notes: [{ text: 'old', timestamp: NOW - 5 * DAYS }] });
    const result = getRecommendation(null, cg);
    expect(result.ctaLabel).toBe('Send Email');
    expect(result.actionType).toBe('send_email');
  });

  it('includes risk for 7+ day stale', () => {
    const cg = makeCg({ notes: [{ text: 'old', timestamp: NOW - 10 * DAYS }] });
    const result = getRecommendation(null, cg);
    expect(result.risk).toBeTruthy();
  });
});
