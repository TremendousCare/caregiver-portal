/**
 * Phase 1.5 — retrospective grade merge into autonomy evaluator.
 *
 *   - latestGradePerSuggestion: dedupes append-only history to the
 *     current verdict per suggestion_id.
 *   - gradeToActionRow: maps a verdict onto the AgentActionRow shape
 *     evaluatePromotion consumes.
 *   - mergeGradesIntoActions: combines live agent_actions with
 *     synthesized grade rows, sorted most-recent-first, trimmed to
 *     lookback_window.
 *   - recordAutonomyOutcomeV2: end-to-end integration — grades feed
 *     into the verdict alongside live actions.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  latestGradePerSuggestion,
  gradeToActionRow,
  mergeGradesIntoActions,
  evaluatePromotion,
  recordAutonomyOutcomeV2,
} from '../../../supabase/functions/_shared/operations/autonomy.ts';

const AGENT_ID = 'agent-recruiting-uuid';
const ORG_ID = '62fbaf9d-13ab-49f4-b92a-a774c67b69a6';

function grade(suggestionId, verdict, gradedAt) {
  return { suggestion_id: suggestionId, verdict, graded_at: gradedAt };
}

function action({ phase = 'executed', severity = null, created_at }) {
  return {
    phase,
    payload: severity ? { severity } : {},
    created_at,
  };
}

function v2Entry(overrides = {}) {
  return {
    current_level: 'L1',
    max_level: 'L4',
    lookback_window: 50,
    promotion_thresholds: {
      'L1->L2': { min_consecutive: 5, min_success_rate: 0.8, min_sample: 10 },
      'L2->L3': { min_consecutive: 10, min_success_rate: 0.9, min_sample: 30 },
      'L3->L4': { min_consecutive: 20, min_success_rate: 0.95, min_sample: 100 },
    },
    demote_on_harmful: true,
    lockout_hours_after_demote: 24,
    lockout_until: null,
    ...overrides,
  };
}

// ─── latestGradePerSuggestion ───

describe('latestGradePerSuggestion', () => {
  it('returns empty for empty input', () => {
    expect(latestGradePerSuggestion([])).toEqual([]);
    expect(latestGradePerSuggestion(null)).toEqual([]);
    expect(latestGradePerSuggestion(undefined)).toEqual([]);
  });

  it('returns one row per suggestion when no duplicates', () => {
    const out = latestGradePerSuggestion([
      grade('s1', 'good', '2026-05-10T10:00:00Z'),
      grade('s2', 'bad', '2026-05-10T11:00:00Z'),
    ]);
    expect(out).toHaveLength(2);
    const ids = out.map((g) => g.suggestion_id).sort();
    expect(ids).toEqual(['s1', 's2']);
  });

  it('keeps the most recent verdict when a suggestion is regraded', () => {
    const out = latestGradePerSuggestion([
      grade('s1', 'good', '2026-05-10T10:00:00Z'),
      grade('s1', 'harmful', '2026-05-10T12:00:00Z'),
      grade('s1', 'bad', '2026-05-10T09:00:00Z'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toBe('harmful');
    expect(out[0].graded_at).toBe('2026-05-10T12:00:00Z');
  });

  it('skips rows missing suggestion_id or graded_at', () => {
    const out = latestGradePerSuggestion([
      grade('s1', 'good', '2026-05-10T10:00:00Z'),
      { suggestion_id: null, verdict: 'good', graded_at: '2026-05-10T11:00:00Z' },
      { suggestion_id: 's2', verdict: 'good', graded_at: null },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].suggestion_id).toBe('s1');
  });
});

// ─── gradeToActionRow ───

describe('gradeToActionRow', () => {
  it("maps 'good' to phase=confirmed with empty payload", () => {
    const r = gradeToActionRow(grade('s1', 'good', '2026-05-10T10:00:00Z'));
    expect(r.phase).toBe('confirmed');
    expect(r.payload).toEqual({});
    expect(r.created_at).toBe('2026-05-10T10:00:00Z');
  });

  it("maps 'bad' to phase=rejected with empty payload", () => {
    const r = gradeToActionRow(grade('s1', 'bad', '2026-05-10T10:00:00Z'));
    expect(r.phase).toBe('rejected');
    expect(r.payload).toEqual({});
  });

  it("maps 'harmful' to phase=rejected with severity='harmful'", () => {
    const r = gradeToActionRow(grade('s1', 'harmful', '2026-05-10T10:00:00Z'));
    expect(r.phase).toBe('rejected');
    expect(r.payload).toEqual({ severity: 'harmful' });
  });
});

// ─── mergeGradesIntoActions ───

describe('mergeGradesIntoActions', () => {
  it('returns actions only when grades is empty', () => {
    const acts = [action({ created_at: '2026-05-10T10:00:00Z' })];
    expect(mergeGradesIntoActions(acts, [], 50)).toEqual(acts);
  });

  it('sorts merged list most-recent-first by created_at', () => {
    const acts = [
      action({ phase: 'executed', created_at: '2026-05-10T08:00:00Z' }),
      action({ phase: 'executed', created_at: '2026-05-10T12:00:00Z' }),
    ];
    const grades = [
      grade('s1', 'good', '2026-05-10T10:00:00Z'),
      grade('s2', 'bad', '2026-05-10T14:00:00Z'),
    ];
    const merged = mergeGradesIntoActions(acts, grades, 50);
    const timestamps = merged.map((m) => m.created_at);
    expect(timestamps).toEqual([
      '2026-05-10T14:00:00Z',
      '2026-05-10T12:00:00Z',
      '2026-05-10T10:00:00Z',
      '2026-05-10T08:00:00Z',
    ]);
  });

  it('trims to lookback_window', () => {
    const acts = Array.from({ length: 10 }, (_, i) =>
      action({ phase: 'executed', created_at: `2026-05-10T0${i}:00:00Z` })
    );
    const grades = Array.from({ length: 10 }, (_, i) =>
      grade(`s${i}`, 'good', `2026-05-10T1${i}:00:00Z`)
    );
    const merged = mergeGradesIntoActions(acts, grades, 5);
    expect(merged).toHaveLength(5);
  });

  it('only includes the latest grade per suggestion (regrade collapses)', () => {
    const merged = mergeGradesIntoActions(
      [],
      [
        grade('s1', 'good', '2026-05-10T10:00:00Z'),
        grade('s1', 'harmful', '2026-05-10T12:00:00Z'),
      ],
      50,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].phase).toBe('rejected');
    expect(merged[0].payload).toEqual({ severity: 'harmful' });
  });
});

// ─── evaluatePromotion with merged grades ───

describe('evaluatePromotion — grade-augmented timeline', () => {
  it("counts 'good' grades toward promotion success rate", () => {
    // No live actions; grades alone supply the calibration sample.
    const grades = Array.from({ length: 15 }, (_, i) =>
      grade(`s${i}`, 'good', `2026-05-10T${String(i).padStart(2, '0')}:00:00Z`)
    );
    const merged = mergeGradesIntoActions([], grades, 50);
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1' }),
      recentActions: merged,
    });
    expect(v.shouldPromote).toBe(true);
    expect(v.newLevel).toBe('L2');
    expect(v.metrics.sample_size).toBe(15);
    expect(v.metrics.success_rate).toBe(1);
  });

  it("a single 'harmful' grade triggers demote", () => {
    const grades = [
      grade('s1', 'harmful', '2026-05-10T12:00:00Z'),
      ...Array.from({ length: 10 }, (_, i) =>
        grade(`s${i + 2}`, 'good', `2026-05-10T${String(i).padStart(2, '0')}:00:00Z`)
      ),
    ];
    const merged = mergeGradesIntoActions([], grades, 50);
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L3' }),
      recentActions: merged,
    });
    expect(v.shouldDemote).toBe(true);
    expect(v.newLevel).toBe('L2');
    expect(v.metrics.harmful_at).toBe('2026-05-10T12:00:00Z');
  });

  it("a 'bad' grade reduces success rate and blocks marginal promotion", () => {
    // 10 good grades + 1 bad grade = 91% success — above the L1->L2
    // floor of 80%, would normally promote. With min_success_rate set
    // to 0.95 we should hold.
    const goodGrades = Array.from({ length: 10 }, (_, i) =>
      grade(`s${i}`, 'good', `2026-05-10T${String(i).padStart(2, '0')}:00:00Z`)
    );
    const merged = mergeGradesIntoActions(
      [],
      [...goodGrades, grade('sb', 'bad', '2026-05-10T20:00:00Z')],
      50,
    );
    const v = evaluatePromotion({
      entry: v2Entry({
        current_level: 'L1',
        promotion_thresholds: {
          'L1->L2': { min_consecutive: 5, min_success_rate: 0.95, min_sample: 10 },
          'L2->L3': { min_consecutive: 10, min_success_rate: 0.9, min_sample: 30 },
          'L3->L4': { min_consecutive: 20, min_success_rate: 0.95, min_sample: 100 },
        },
      }),
      recentActions: merged,
    });
    expect(v.shouldPromote).toBe(false);
    expect(v.metrics.sample_size).toBe(11);
  });
});

// ─── recordAutonomyOutcomeV2 — grade-fetch integration ───

function makeSupabaseMockWithGrades({
  agentRow,
  agentActions = [],
  grades = [],
  gradesLoadError = null,
  rpcError = null,
} = {}) {
  const rpcCalls = [];
  const inserts = [];
  const gradeQueryCalls = [];

  const fromImpl = vi.fn((table) => {
    if (table === 'agents') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: agentRow, error: null })),
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
                limit: vi.fn(async () => ({ data: agentActions, error: null })),
              })),
            })),
          })),
        })),
      };
    }
    if (table === 'ai_suggestion_grades') {
      gradeQueryCalls.push({ table });
      return {
        select: vi.fn((sel) => {
          gradeQueryCalls[gradeQueryCalls.length - 1].select = sel;
          return {
            eq: vi.fn((col, val) => {
              gradeQueryCalls[gradeQueryCalls.length - 1].eq1 = { col, val };
              return {
                eq: vi.fn((col2, val2) => {
                  gradeQueryCalls[gradeQueryCalls.length - 1].eq2 = { col: col2, val: val2 };
                  return {
                    order: vi.fn(() => ({
                      limit: vi.fn(async () => ({
                        data: gradesLoadError ? null : grades,
                        error: gradesLoadError,
                      })),
                    })),
                  };
                }),
              };
            }),
          };
        }),
      };
    }
    if (table === 'events') {
      return {
        insert: vi.fn(async (row) => {
          inserts.push({ table, row });
          return { error: null };
        }),
      };
    }
    throw new Error(`unmocked table: ${table}`);
  });

  const rpcImpl = vi.fn(async (fn, args) => {
    rpcCalls.push({ fn, args });
    return { data: null, error: rpcError };
  });

  return {
    from: fromImpl,
    rpc: rpcImpl,
    _rpcCalls: rpcCalls,
    _inserts: inserts,
    _gradeQueryCalls: gradeQueryCalls,
  };
}

describe('recordAutonomyOutcomeV2 — grade fetch and merge', () => {
  it('queries ai_suggestion_grades filtered by agent_id and action_type', async () => {
    const sb = makeSupabaseMockWithGrades({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 3,
        autonomy_profile: { send_sms: v2Entry({ current_level: 'L1' }) },
      },
      agentActions: [],
      grades: [],
    });

    await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });

    expect(sb._gradeQueryCalls).toHaveLength(1);
    expect(sb._gradeQueryCalls[0].eq1.col).toBe('ai_suggestions.agent_id');
    expect(sb._gradeQueryCalls[0].eq1.val).toBe(AGENT_ID);
    expect(sb._gradeQueryCalls[0].eq2.col).toBe('ai_suggestions.action_type');
    expect(sb._gradeQueryCalls[0].eq2.val).toBe('send_sms');
  });

  it('merges grades into the timeline — grades alone can drive promotion', async () => {
    // No agent_actions, but 15 'good' grades → promote L1→L2.
    const grades = Array.from({ length: 15 }, (_, i) =>
      grade(`s${i}`, 'good', `2026-05-10T${String(i).padStart(2, '0')}:00:00Z`)
    );
    const sb = makeSupabaseMockWithGrades({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 3,
        autonomy_profile: { send_sms: v2Entry({ current_level: 'L1' }) },
      },
      agentActions: [],
      grades,
    });

    const result = await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });

    expect(result.applied).toBe('promoted');
    expect(result.newLevel).toBe('L2');
    expect(sb._rpcCalls.length).toBe(1);
    expect(sb._rpcCalls[0].args.p_entry.current_level).toBe('L2');
  });

  it('a single harmful grade demotes even with otherwise green actions', async () => {
    const sb = makeSupabaseMockWithGrades({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 3,
        autonomy_profile: { send_sms: v2Entry({ current_level: 'L3' }) },
      },
      agentActions: Array.from({ length: 10 }, (_, i) =>
        action({ phase: 'executed', created_at: `2026-05-10T0${i}:00:00Z` }),
      ),
      grades: [grade('sX', 'harmful', '2026-05-10T20:00:00Z')],
    });

    const result = await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });

    expect(result.applied).toBe('demoted');
    expect(result.newLevel).toBe('L2');
  });

  it('grade fetch failure does not crash — falls back to actions-only', async () => {
    const sb = makeSupabaseMockWithGrades({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 3,
        autonomy_profile: { send_sms: v2Entry({ current_level: 'L1' }) },
      },
      agentActions: Array.from({ length: 20 }, () =>
        action({ phase: 'executed', created_at: '2026-05-10T10:00:00Z' }),
      ),
      gradesLoadError: { message: 'permission denied' },
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });
    // 20 'executed' actions in window → promote L1→L2 even though
    // grade fetch failed.
    expect(result.applied).toBe('promoted');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
