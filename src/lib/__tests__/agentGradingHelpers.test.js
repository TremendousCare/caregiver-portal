/**
 * Phase 1.5 — pure helpers for the retrospective grading UI.
 *
 * Mirrors the test pattern used by `agentMetricsAggregation.test.js`:
 * factories for rows, no React, no Supabase.
 */

import { describe, it, expect } from 'vitest';

import {
  latestGradeBySuggestion,
  applyUngradedFilter,
  uniqueActionTypes,
  truncate,
  gradeBreakdown,
  verdictClass,
  VERDICTS,
} from '../../components/agentGrading/gradingHelpers';
import { sinceIsoForDays } from '../../components/agentGrading/queries';

function grade(suggestionId, verdict, gradedAt, rest = {}) {
  return { suggestion_id: suggestionId, verdict, graded_at: gradedAt, ...rest };
}

function suggestion(id, overrides = {}) {
  return {
    id,
    source_type: 'proactive',
    action_type: 'send_sms',
    title: `Suggestion ${id}`,
    drafted_content: null,
    intent: null,
    entity_type: null,
    entity_id: null,
    entity_name: null,
    autonomy_level: 'L1',
    status: 'pending',
    created_at: '2026-05-10T10:00:00Z',
    ...overrides,
  };
}

describe('VERDICTS export', () => {
  it('exports the three verdict tokens in order', () => {
    expect(VERDICTS).toEqual(['good', 'bad', 'harmful']);
  });
});

describe('latestGradeBySuggestion', () => {
  it('returns an empty Map for non-array input', () => {
    expect(latestGradeBySuggestion(null).size).toBe(0);
    expect(latestGradeBySuggestion(undefined).size).toBe(0);
    expect(latestGradeBySuggestion('not array').size).toBe(0);
  });

  it('returns the most recent grade per suggestion_id', () => {
    const m = latestGradeBySuggestion([
      grade('s1', 'good', '2026-05-10T10:00:00Z'),
      grade('s1', 'harmful', '2026-05-10T12:00:00Z'),
      grade('s2', 'bad', '2026-05-10T11:00:00Z'),
    ]);
    expect(m.size).toBe(2);
    expect(m.get('s1').verdict).toBe('harmful');
    expect(m.get('s2').verdict).toBe('bad');
  });

  it('skips rows missing suggestion_id or graded_at', () => {
    const m = latestGradeBySuggestion([
      grade('s1', 'good', '2026-05-10T10:00:00Z'),
      grade(null, 'good', '2026-05-10T10:00:00Z'),
      grade('s2', 'good', null),
    ]);
    expect(m.size).toBe(1);
    expect(m.has('s1')).toBe(true);
  });
});

describe('applyUngradedFilter', () => {
  it('passes the original list through when ungradedOnly is false', () => {
    const sugs = [suggestion('s1'), suggestion('s2')];
    const grades = latestGradeBySuggestion([grade('s1', 'good', '2026-05-10T10:00:00Z')]);
    expect(applyUngradedFilter(sugs, grades, false)).toEqual(sugs);
  });

  it('removes graded rows when ungradedOnly is true', () => {
    const sugs = [suggestion('s1'), suggestion('s2'), suggestion('s3')];
    const grades = latestGradeBySuggestion([
      grade('s1', 'good', '2026-05-10T10:00:00Z'),
      grade('s3', 'bad', '2026-05-10T11:00:00Z'),
    ]);
    const out = applyUngradedFilter(sugs, grades, true);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('s2');
  });
});

describe('uniqueActionTypes', () => {
  it('returns sorted unique action_types, excluding null', () => {
    const types = uniqueActionTypes([
      suggestion('s1', { action_type: 'send_sms' }),
      suggestion('s2', { action_type: 'add_note' }),
      suggestion('s3', { action_type: 'send_sms' }),
      suggestion('s4', { action_type: null }),
    ]);
    expect(types).toEqual(['add_note', 'send_sms']);
  });

  it('returns [] for empty input', () => {
    expect(uniqueActionTypes([])).toEqual([]);
    expect(uniqueActionTypes(null)).toEqual([]);
  });
});

describe('truncate', () => {
  it('passes short strings through unchanged', () => {
    expect(truncate('hi', 10)).toBe('hi');
  });

  it('truncates long strings with ellipsis', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });

  it('handles null/undefined', () => {
    expect(truncate(null)).toBe('');
    expect(truncate(undefined)).toBe('');
  });
});

describe('gradeBreakdown', () => {
  it('counts each verdict and ungraded', () => {
    const sugs = [
      suggestion('s1'), suggestion('s2'), suggestion('s3'),
      suggestion('s4'), suggestion('s5'),
    ];
    const grades = latestGradeBySuggestion([
      grade('s1', 'good', '2026-05-10T10:00:00Z'),
      grade('s2', 'good', '2026-05-10T10:00:00Z'),
      grade('s3', 'bad', '2026-05-10T10:00:00Z'),
      grade('s4', 'harmful', '2026-05-10T10:00:00Z'),
    ]);
    expect(gradeBreakdown(sugs, grades)).toEqual({
      good: 2, bad: 1, harmful: 1, ungraded: 1,
    });
  });

  it('returns zeros for empty input', () => {
    expect(gradeBreakdown([], new Map())).toEqual({
      good: 0, bad: 0, harmful: 0, ungraded: 0,
    });
  });
});

describe('verdictClass', () => {
  it('maps each verdict to a stable class suffix', () => {
    expect(verdictClass('good')).toBe('good');
    expect(verdictClass('bad')).toBe('bad');
    expect(verdictClass('harmful')).toBe('harmful');
    expect(verdictClass(null)).toBe('ungraded');
    expect(verdictClass(undefined)).toBe('ungraded');
    expect(verdictClass('weird')).toBe('ungraded');
  });
});

describe('sinceIsoForDays', () => {
  it('returns ISO N days before a fixed clock', () => {
    const now = Date.parse('2026-05-12T00:00:00Z');
    expect(sinceIsoForDays(7, now)).toBe('2026-05-05T00:00:00.000Z');
  });

  it('returns null for non-positive windows (all-time filter)', () => {
    expect(sinceIsoForDays(0)).toBeNull();
    expect(sinceIsoForDays(-1)).toBeNull();
  });
});
