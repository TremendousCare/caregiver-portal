/**
 * Phase 1.2 — autonomy promotion algorithm v2.
 *
 *   - evaluatePromotion: pure decision verdict over per-(agent × action)
 *     thresholds with sliding window + auto-demote on harm + lockout.
 *   - recordAutonomyOutcomeV2: stateful wrapper that loads the agent row,
 *     reads the agent_actions window, applies the verdict, and logs an
 *     `events` row. All side-effects fire-and-forget; failures swallow.
 *
 * The pure path (`evaluatePromotion`) is the heavy spec; the wrapper has
 * thinner coverage focused on the integration glue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  evaluatePromotion,
  normalizeEntry,
  recordAutonomyOutcomeV2,
  AUTONOMY_LEVEL_ORDER,
} from '../../../supabase/functions/_shared/operations/autonomy.ts';

// ─── Helpers ───

const AGENT_ID = 'agent-recruiting-uuid';
const ORG_ID = '62fbaf9d-13ab-49f4-b92a-a774c67b69a6';
const NOW = '2026-05-10T18:00:00.000Z';

function makeAction({ phase = 'executed', severity = null, created_at = '2026-05-10T17:00:00.000Z' } = {}) {
  return {
    phase,
    payload: severity ? { severity } : {},
    created_at,
  };
}

function makeApprovals(n) {
  return Array.from({ length: n }, () => makeAction({ phase: 'executed' }));
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

// ─── normalizeEntry ───

describe('normalizeEntry', () => {
  it('layers in v2 defaults for v1 inputs', () => {
    const out = normalizeEntry({ current_level: 'L2' });
    expect(out.current_level).toBe('L2');
    expect(out.max_level).toBe('L4');
    expect(out.lookback_window).toBe(50);
    expect(out.demote_on_harmful).toBe(true);
    expect(out.lockout_hours_after_demote).toBe(24);
    expect(out.lockout_until).toBeNull();
    expect(out.last_demote_at).toBeNull();
    expect(out.promotion_thresholds['L1->L2']).toEqual({
      min_consecutive: 5, min_success_rate: 0.8, min_sample: 10,
    });
  });

  it('clamps invalid current_level to L1', () => {
    const out = normalizeEntry({ current_level: 'NOPE' });
    expect(out.current_level).toBe('L1');
  });

  it('preserves admin-supplied custom thresholds', () => {
    const custom = { 'L1->L2': { min_consecutive: 3, min_success_rate: 0.5, min_sample: 5 } };
    const out = normalizeEntry({ current_level: 'L1', promotion_thresholds: custom });
    expect(out.promotion_thresholds).toBe(custom);
  });

  it('treats null/undefined as L1 with full defaults', () => {
    const a = normalizeEntry(null);
    const b = normalizeEntry(undefined);
    expect(a.current_level).toBe('L1');
    expect(b.current_level).toBe('L1');
    expect(a.lookback_window).toBe(50);
  });
});

// ─── evaluatePromotion: promotion path ───

describe('evaluatePromotion — promotion path', () => {
  it('promotes L1 → L2 when all thresholds met', () => {
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1' }),
      recentActions: makeApprovals(15), // sample 15, success 1.0, consecutive 15
      now: NOW,
    });
    expect(v.shouldPromote).toBe(true);
    expect(v.shouldDemote).toBe(false);
    expect(v.newLevel).toBe('L2');
    expect(v.reason).toMatch(/Promoted L1->L2/);
  });

  it('refuses promotion when sample size is below the threshold', () => {
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1' }),
      recentActions: makeApprovals(8), // < min_sample=10
      now: NOW,
    });
    expect(v.shouldPromote).toBe(false);
    expect(v.newLevel).toBe('L1');
    expect(v.reason).toMatch(/Sample size 8 < required 10/);
  });

  it('refuses promotion when success rate is below the threshold', () => {
    // 10 actions: 7 executed, 3 rejected -> 70% < 80%
    const actions = [
      ...Array.from({ length: 7 }, () => makeAction({ phase: 'executed' })),
      ...Array.from({ length: 3 }, () => makeAction({ phase: 'rejected' })),
    ];
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1' }),
      recentActions: actions,
      now: NOW,
    });
    expect(v.shouldPromote).toBe(false);
    expect(v.reason).toMatch(/Success rate .* < required 0\.8/);
  });

  it('refuses promotion when consecutive count is below the threshold', () => {
    // 12 actions, last 4 are rejections breaking consecutive (most recent first):
    // [reject, reject, reject, reject, exec×8] → consecutive = 0
    const actions = [
      ...Array.from({ length: 4 }, () => makeAction({ phase: 'rejected' })),
      ...Array.from({ length: 8 }, () => makeAction({ phase: 'executed' })),
    ];
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1' }),
      recentActions: actions,
      now: NOW,
    });
    // 8/12 = 66.7% which is also below 80% — but the failure message
    // chosen by the evaluator is the *first* gate that fails. Sample
    // passes (12), success rate is 0.667 — that's the gate it fails on.
    expect(v.shouldPromote).toBe(false);
    expect(v.reason).toMatch(/Success rate|Consecutive/);
  });

  it('counts auto_executed phases as successes', () => {
    const actions = Array.from({ length: 12 }, () => makeAction({ phase: 'auto_executed' }));
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1' }),
      recentActions: actions,
      now: NOW,
    });
    expect(v.shouldPromote).toBe(true);
  });

  it('counts confirmed phases as successes', () => {
    const actions = Array.from({ length: 12 }, () => makeAction({ phase: 'confirmed' }));
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1' }),
      recentActions: actions,
      now: NOW,
    });
    expect(v.shouldPromote).toBe(true);
  });

  it('treats expired phases as failures', () => {
    const actions = [
      ...Array.from({ length: 9 }, () => makeAction({ phase: 'executed' })),
      ...Array.from({ length: 3 }, () => makeAction({ phase: 'expired' })),
    ];
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1' }),
      recentActions: actions,
      now: NOW,
    });
    // 9/12 = 75% < 80%
    expect(v.shouldPromote).toBe(false);
    expect(v.reason).toMatch(/Success rate/);
  });

  it('ignores non-resolved phases (suggested, shadow) in metrics', () => {
    const actions = [
      ...Array.from({ length: 12 }, () => makeAction({ phase: 'executed' })),
      ...Array.from({ length: 5 }, () => makeAction({ phase: 'suggested' })),
      ...Array.from({ length: 5 }, () => makeAction({ phase: 'shadow' })),
    ];
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1' }),
      recentActions: actions,
      now: NOW,
    });
    expect(v.shouldPromote).toBe(true);
    expect(v.metrics.sample_size).toBe(12);
    expect(v.metrics.consecutive_approvals).toBe(12);
  });

  it('respects max_level cap (refuses to promote past it)', () => {
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L2', max_level: 'L2' }),
      recentActions: makeApprovals(40), // would promote L2->L3 if not capped
      now: NOW,
    });
    expect(v.shouldPromote).toBe(false);
    expect(v.reason).toMatch(/Cap reached/);
  });

  it('refuses promotion past L4', () => {
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L4' }),
      recentActions: makeApprovals(50),
      now: NOW,
    });
    expect(v.shouldPromote).toBe(false);
    expect(v.reason).toMatch(/Already at L4/);
  });

  it('uses per-transition thresholds (L2->L3 stricter than L1->L2)', () => {
    // 30 successes pass L1->L2 easily, but L2->L3 requires min_sample=30
    // AND min_consecutive=10 AND success_rate>=0.9. 30 successes: yes.
    // Now try with 25 successes:
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L2' }),
      recentActions: makeApprovals(25),
      now: NOW,
    });
    expect(v.shouldPromote).toBe(false);
    expect(v.reason).toMatch(/Sample size 25 < required 30/);
  });

  it('honors lookback_window (only the most recent N rows count)', () => {
    // 100 rejections + 12 successes (in DB order, most recent first = 12 successes first)
    const actions = [
      ...Array.from({ length: 12 }, () => makeAction({ phase: 'executed' })),
      ...Array.from({ length: 100 }, () => makeAction({ phase: 'rejected' })),
    ];
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1', lookback_window: 12 }),
      recentActions: actions,
      now: NOW,
    });
    expect(v.shouldPromote).toBe(true);
    expect(v.metrics.sample_size).toBe(12);
  });
});

// ─── evaluatePromotion: demote-on-harm path ───

describe('evaluatePromotion — demote on harm', () => {
  it('immediately demotes one level on a harmful outcome', () => {
    const actions = [
      makeAction({ phase: 'executed', severity: 'harmful', created_at: '2026-05-10T17:30:00.000Z' }),
      ...makeApprovals(20),
    ];
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L3' }),
      recentActions: actions,
      now: NOW,
    });
    expect(v.shouldDemote).toBe(true);
    expect(v.shouldPromote).toBe(false);
    expect(v.newLevel).toBe('L2');
    expect(v.reason).toMatch(/Demoted to L2 due to harmful outcome/);
    expect(v.metrics.harmful_present).toBe(true);
    expect(v.metrics.harmful_at).toBe('2026-05-10T17:30:00.000Z');
  });

  it('does not demote past L1', () => {
    const actions = [makeAction({ phase: 'executed', severity: 'harmful' })];
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1' }),
      recentActions: actions,
      now: NOW,
    });
    expect(v.shouldDemote).toBe(false);
    expect(v.shouldPromote).toBe(false);
    expect(v.reason).toMatch(/already at L1/);
  });

  it('honors demote_on_harmful=false (no demote on harm)', () => {
    const actions = [
      makeAction({ phase: 'executed', severity: 'harmful' }),
      ...makeApprovals(20),
    ];
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L3', demote_on_harmful: false }),
      recentActions: actions,
      now: NOW,
    });
    expect(v.shouldDemote).toBe(false);
  });

  it('does NOT count harmful outcomes as successes for promotion', () => {
    // 12 actions, all 'executed' but one is harmful. Without
    // demote-on-harm, the harmful row should still NOT count toward
    // promotion success — it counts as a failure.
    const actions = [
      ...Array.from({ length: 11 }, () => makeAction({ phase: 'executed' })),
      makeAction({ phase: 'executed', severity: 'harmful' }),
    ];
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L1', demote_on_harmful: false }),
      recentActions: actions,
      now: NOW,
    });
    // 11/12 successes = 91.7% > 80%, sample 12, consecutive 11 → promote
    expect(v.shouldPromote).toBe(true);
    expect(v.metrics.success_rate).toBeCloseTo(11 / 12, 5);
  });
});

// ─── evaluatePromotion: idempotent harm handling (Codex P2 fix) ───

describe('evaluatePromotion — last_demote_at idempotency', () => {
  it('does NOT re-demote when the harmful action equals last_demote_at', () => {
    // The harmful row is still in the lookback window, but we already
    // demoted on it — must hold.
    const harmfulAt = '2026-05-10T17:00:00.000Z';
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L2', last_demote_at: harmfulAt }),
      recentActions: [
        makeAction({ phase: 'executed', severity: 'harmful', created_at: harmfulAt }),
        ...makeApprovals(20),
      ],
      now: '2026-05-10T18:00:00.000Z',
    });
    expect(v.shouldDemote).toBe(false);
    // Promotion should still be blocked by lockout if present, but with
    // no lockout marker and 20 successes since the harmful row, the
    // verdict should not promote either (the harmful row counts as a
    // failure in success-rate metrics) — held by the success-rate gate.
    expect(v.shouldPromote).toBe(false);
  });

  it('does NOT re-demote when the harmful action is older than last_demote_at', () => {
    const harmfulAt = '2026-05-10T15:00:00.000Z';
    const lastDemoteAt = '2026-05-10T17:00:00.000Z';
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L2', last_demote_at: lastDemoteAt }),
      recentActions: [
        makeAction({ phase: 'executed', severity: 'harmful', created_at: harmfulAt }),
      ],
      now: '2026-05-10T18:00:00.000Z',
    });
    expect(v.shouldDemote).toBe(false);
  });

  it('DOES re-demote when a newer harmful action arrives', () => {
    const oldHarmAt = '2026-05-10T15:00:00.000Z';
    const newHarmAt = '2026-05-10T17:30:00.000Z';
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L3', last_demote_at: oldHarmAt }),
      recentActions: [
        makeAction({ phase: 'executed', severity: 'harmful', created_at: newHarmAt }),
        makeAction({ phase: 'executed', severity: 'harmful', created_at: oldHarmAt }),
        ...makeApprovals(10),
      ],
      now: '2026-05-10T18:00:00.000Z',
    });
    expect(v.shouldDemote).toBe(true);
    expect(v.newLevel).toBe('L2');
  });

  it('demotes on first-ever harmful action when last_demote_at is null', () => {
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L3', last_demote_at: null }),
      recentActions: [
        makeAction({ phase: 'executed', severity: 'harmful' }),
        ...makeApprovals(10),
      ],
      now: NOW,
    });
    expect(v.shouldDemote).toBe(true);
  });

  it('treats unparseable last_demote_at as no marker (demotes once)', () => {
    const v = evaluatePromotion({
      entry: v2Entry({ current_level: 'L3', last_demote_at: 'not-a-date' }),
      recentActions: [
        makeAction({ phase: 'executed', severity: 'harmful' }),
      ],
      now: NOW,
    });
    expect(v.shouldDemote).toBe(true);
  });
});

// ─── evaluatePromotion: lockout window ───

describe('evaluatePromotion — lockout window', () => {
  it('refuses promotion while lockout_until is in the future', () => {
    const v = evaluatePromotion({
      entry: v2Entry({
        current_level: 'L1',
        lockout_until: '2026-05-11T00:00:00.000Z',
      }),
      recentActions: makeApprovals(20),
      now: '2026-05-10T18:00:00.000Z',
    });
    expect(v.shouldPromote).toBe(false);
    expect(v.reason).toMatch(/Promotion locked/);
  });

  it('allows promotion once lockout_until is in the past', () => {
    const v = evaluatePromotion({
      entry: v2Entry({
        current_level: 'L1',
        lockout_until: '2026-05-09T00:00:00.000Z',
      }),
      recentActions: makeApprovals(20),
      now: '2026-05-10T18:00:00.000Z',
    });
    expect(v.shouldPromote).toBe(true);
  });

  it('ignores malformed lockout_until (treats as no lockout)', () => {
    const v = evaluatePromotion({
      entry: v2Entry({
        current_level: 'L1',
        lockout_until: 'not-a-date',
      }),
      recentActions: makeApprovals(20),
      now: NOW,
    });
    expect(v.shouldPromote).toBe(true);
  });
});

// ─── recordAutonomyOutcomeV2 ───

function makeSupabaseMock({
  agentRow = { id: AGENT_ID, org_id: ORG_ID, version: 3, autonomy_profile: { send_sms: { current_level: 'L1' } } },
  agentActions = [],
  agentLoadError = null,
  actionsLoadError = null,
  /**
   * Phase 1.5 — retrospective grades merged into the lookback window
   * by `recordAutonomyOutcomeV2`. Defaults to empty so legacy tests
   * (which predate grades) keep their semantics.
   */
  grades = [],
  gradesLoadError = null,
  /**
   * Codex P2 fix: writes go through the `update_autonomy_profile_entry_v1`
   * RPC (atomic jsonb_set) instead of read-modify-write on the whole
   * `autonomy_profile` column. The mock captures rpc args so tests can
   * assert against the per-action entry that was sent.
   */
  rpcError = null,
} = {}) {
  const rpcCalls = [];
  const inserts = [];

  const fromImpl = vi.fn((table) => {
    if (table === 'agents') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: agentLoadError ? null : agentRow,
              error: agentLoadError,
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
                limit: vi.fn(async () => ({
                  data: actionsLoadError ? null : agentActions,
                  error: actionsLoadError,
                })),
              })),
            })),
          })),
        })),
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
    if (table === 'ai_suggestion_grades') {
      // Phase 1.5 — chain depth: select → eq → eq → order → limit.
      // The final `.limit(...)` is awaited and yields { data, error }.
      const limitFn = vi.fn(async () => ({
        data: gradesLoadError ? null : grades,
        error: gradesLoadError,
      }));
      const orderFn = vi.fn(() => ({ limit: limitFn }));
      const eqFn2 = vi.fn(() => ({ order: orderFn }));
      const eqFn1 = vi.fn(() => ({ eq: eqFn2 }));
      const selectFn = vi.fn(() => ({ eq: eqFn1 }));
      return { select: selectFn };
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordAutonomyOutcomeV2 — integration glue', () => {
  it('updates autonomy_profile and writes event when promotion fires', async () => {
    const sb = makeSupabaseMock({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 3,
        autonomy_profile: { send_sms: v2Entry({ current_level: 'L1' }) },
      },
      agentActions: makeApprovals(20),
    });

    const result = await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });

    expect(result.applied).toBe('promoted');
    expect(result.newLevel).toBe('L2');

    expect(sb._rpcCalls.length).toBe(1);
    expect(sb._rpcCalls[0].fn).toBe('update_autonomy_profile_entry_v1');
    expect(sb._rpcCalls[0].args.p_agent_id).toBe(AGENT_ID);
    expect(sb._rpcCalls[0].args.p_action_type).toBe('send_sms');
    expect(sb._rpcCalls[0].args.p_entry.current_level).toBe('L2');
    expect(sb._rpcCalls[0].args.p_entry.lockout_until).toBeNull();
    expect(sb._rpcCalls[0].args.p_updated_by).toBe('system:autonomy_v2');

    expect(sb._inserts.length).toBe(1);
    expect(sb._inserts[0].row.event_type).toBe('agent_autonomy_promoted');
    expect(sb._inserts[0].row.org_id).toBe(ORG_ID);
    expect(sb._inserts[0].row.agent_id).toBe(AGENT_ID);
    expect(sb._inserts[0].row.payload.from_level).toBe('L1');
    expect(sb._inserts[0].row.payload.to_level).toBe('L2');
    expect(sb._inserts[0].row.payload.agent_version).toBe(3);
  });

  it('sets lockout_until and last_demote_at on demote-on-harm', async () => {
    const harmfulAt = '2026-05-10T17:00:00.000Z';
    const sb = makeSupabaseMock({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 3,
        autonomy_profile: { send_sms: v2Entry({ current_level: 'L3' }) },
      },
      agentActions: [
        makeAction({ phase: 'executed', severity: 'harmful', created_at: harmfulAt }),
        ...makeApprovals(10),
      ],
    });

    const result = await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });

    expect(result.applied).toBe('demoted');
    expect(result.newLevel).toBe('L2');
    const entry = sb._rpcCalls[0].args.p_entry;
    expect(entry.current_level).toBe('L2');
    expect(entry.lockout_until).not.toBeNull();
    // Lockout should be ~24 hours in the future
    const lockMs = Date.parse(entry.lockout_until);
    expect(lockMs - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(lockMs - Date.now()).toBeLessThan(25 * 3600_000);
    // last_demote_at must record the harmful action's timestamp so the
    // next call doesn't re-demote on the same row (Codex P2).
    expect(entry.last_demote_at).toBe(harmfulAt);

    expect(sb._inserts[0].row.event_type).toBe('agent_autonomy_demoted');
  });

  it('returns hold + writes nothing when no transition warranted', async () => {
    const sb = makeSupabaseMock({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 3,
        autonomy_profile: { send_sms: v2Entry({ current_level: 'L1' }) },
      },
      agentActions: makeApprovals(3), // below min_sample
    });

    const result = await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });

    expect(result.applied).toBe('hold');
    expect(sb._rpcCalls.length).toBe(0);
    expect(sb._inserts.length).toBe(0);
  });

  it('uses latest hint to pre-load the just-fired action', async () => {
    // 9 prior approvals + latest=executed brings sample to 10 (min_sample
    // for L1->L2). Without latest, we'd be at 9 and hold.
    const sb = makeSupabaseMock({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 1,
        autonomy_profile: { send_sms: v2Entry({ current_level: 'L1' }) },
      },
      agentActions: makeApprovals(9),
    });

    const noHint = await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });
    expect(noHint.applied).toBe('hold');

    const sb2 = makeSupabaseMock({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 1,
        autonomy_profile: { send_sms: v2Entry({ current_level: 'L1' }) },
      },
      agentActions: makeApprovals(9),
    });
    const withHint = await recordAutonomyOutcomeV2(sb2, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
      latest: { phase: 'executed' },
    });
    expect(withHint.applied).toBe('promoted');
  });

  it('returns hold and logs on agent load failure (does not throw)', async () => {
    const sb = makeSupabaseMock({ agentLoadError: { message: 'boom' } });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });

    expect(result.applied).toBe('hold');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('returns hold and logs on agent_actions load failure', async () => {
    const sb = makeSupabaseMock({
      agentActions: [],
      actionsLoadError: { message: 'boom' },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });

    expect(result.applied).toBe('hold');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('returns hold and logs on RPC failure (no event written)', async () => {
    const sb = makeSupabaseMock({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 1,
        autonomy_profile: { send_sms: v2Entry({ current_level: 'L1' }) },
      },
      agentActions: makeApprovals(20),
      rpcError: { message: 'rpc denied' },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });

    expect(result.applied).toBe('hold');
    expect(sb._inserts.length).toBe(0); // event NOT written if RPC failed
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('preserves admin-supplied custom keys on the action entry through promotion', async () => {
    const sb = makeSupabaseMock({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 3,
        autonomy_profile: {
          send_sms: { ...v2Entry({ current_level: 'L1' }), notes: 'admin custom' },
        },
      },
      agentActions: makeApprovals(20),
    });

    await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });

    const entry = sb._rpcCalls[0].args.p_entry;
    expect(entry.current_level).toBe('L2');
    expect(entry.notes).toBe('admin custom');
  });

  it('does not touch the agents table directly (writes via RPC only)', async () => {
    // Codex P2 #r3214228075: the wrapper must NOT do read-modify-write
    // on the whole autonomy_profile column. Only the SECURITY DEFINER
    // RPC (atomic jsonb_set) is allowed as a write path.
    const sb = makeSupabaseMock({
      agentRow: {
        id: AGENT_ID,
        org_id: ORG_ID,
        version: 1,
        autonomy_profile: { send_sms: v2Entry({ current_level: 'L1' }) },
      },
      agentActions: makeApprovals(20),
    });
    await recordAutonomyOutcomeV2(sb, {
      agentId: AGENT_ID,
      actionType: 'send_sms',
    });
    // The mock's `agents` from() chain doesn't expose `update`. If the
    // implementation tried to call it, the test would throw — proving
    // the contract via absence.
    const agentsCall = sb.from.mock.results.find(
      (r) => r.value && typeof r.value.select === 'function' && typeof r.value.update !== 'function',
    );
    expect(agentsCall).toBeDefined();
  });
});

describe('AUTONOMY_LEVEL_ORDER constant', () => {
  it('preserves ordering for max_level comparisons', () => {
    expect(AUTONOMY_LEVEL_ORDER.L1).toBe(1);
    expect(AUTONOMY_LEVEL_ORDER.L2).toBe(2);
    expect(AUTONOMY_LEVEL_ORDER.L3).toBe(3);
    expect(AUTONOMY_LEVEL_ORDER.L4).toBe(4);
  });
});
