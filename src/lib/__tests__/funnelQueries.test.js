import { describe, it, expect } from 'vitest';
import {
  PERIODS,
  PERIOD_LABELS,
  LOSS_REASON_LABELS,
  COLD_THRESHOLD_DAYS,
  periodStart,
  daysSince,
  computeFunnel,
  rankAccountsByPipeline,
  lossReasonBreakdown,
  coldAccounts,
  fetchBdFunnelData,
} from '../../features/bd-funnel/lib/funnelQueries';

const NOW = new Date('2026-05-09T12:00:00Z').getTime();
const dayAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

// ─── Constants ───────────────────────────────────────────────────

describe('exported constants', () => {
  it('PERIODS lists the period keys in order', () => {
    expect(PERIODS).toEqual(['week', 'month', 'quarter', 'year']);
  });
  it('PERIOD_LABELS covers every period', () => {
    for (const p of PERIODS) {
      expect(PERIOD_LABELS[p], `label for ${p}`).toBeTruthy();
    }
  });
  it('LOSS_REASON_LABELS covers the bd_referrals.loss_reason CHECK domain', () => {
    expect(Object.keys(LOSS_REASON_LABELS).sort()).toEqual([
      'chose_other_agency',
      'cost',
      'did_not_qualify',
      'insurance_denied',
      'lost_contact',
      'other',
      'patient_passed',
    ]);
  });
  it('COLD_THRESHOLD_DAYS matches the Today/Account-list cold heuristic', () => {
    expect(COLD_THRESHOLD_DAYS).toBe(21);
  });
});

// ─── periodStart / daysSince ─────────────────────────────────────

describe('periodStart', () => {
  it('returns now − N days for each period', () => {
    expect(NOW - periodStart('week',    NOW).getTime()).toBe(7   * 86400000);
    expect(NOW - periodStart('month',   NOW).getTime()).toBe(30  * 86400000);
    expect(NOW - periodStart('quarter', NOW).getTime()).toBe(90  * 86400000);
    expect(NOW - periodStart('year',    NOW).getTime()).toBe(365 * 86400000);
  });
  it('falls back to month for an unknown period', () => {
    expect(NOW - periodStart('garbage', NOW).getTime()).toBe(30 * 86400000);
  });
});

describe('daysSince', () => {
  it('returns whole days', () => {
    expect(daysSince(dayAgo(3), NOW)).toBe(3);
    expect(daysSince(dayAgo(0), NOW)).toBe(0);
  });
  it('returns null for bad input', () => {
    expect(daysSince(null, NOW)).toBe(null);
    expect(daysSince('garbage', NOW)).toBe(null);
  });
});

// ─── computeFunnel ───────────────────────────────────────────────

describe('computeFunnel', () => {
  const activities = [
    { activity_type: 'visit',    occurred_at: dayAgo(2)  },
    { activity_type: 'visit',    occurred_at: dayAgo(3)  },
    { activity_type: 'visit',    occurred_at: dayAgo(40) }, // outside week
    { activity_type: 'call',     occurred_at: dayAgo(2)  }, // not a visit
    { activity_type: 'drop_off', occurred_at: dayAgo(1)  }, // not a visit
  ];
  const referrals = [
    { referred_at: dayAgo(2),  soc_at: null,        lost_at: null,        loss_reason: null },
    { referred_at: dayAgo(4),  soc_at: dayAgo(1),   lost_at: null,        loss_reason: null },
    { referred_at: dayAgo(40), soc_at: null,        lost_at: dayAgo(2),   loss_reason: 'cost' },
    { referred_at: dayAgo(40), soc_at: null,        lost_at: dayAgo(40),  loss_reason: 'cost' }, // outside week
  ];

  it('counts visits, referrals, SOCs, lost in window only', () => {
    const f = computeFunnel(activities, referrals, 'week', NOW);
    expect(f.visits).toBe(2);
    expect(f.referrals).toBe(2);
    expect(f.socs).toBe(1);
    expect(f.lost).toBe(1);
  });

  it('computes conversion rates', () => {
    const f = computeFunnel(activities, referrals, 'week', NOW);
    expect(f.visit_to_referral).toBeCloseTo(2 / 2, 5); // 1.0
    expect(f.referral_to_soc).toBeCloseTo(1 / 2, 5);    // 0.5
  });

  it('returns 0 conversion when denominator is 0', () => {
    const f = computeFunnel([], [], 'week', NOW);
    expect(f.visit_to_referral).toBe(0);
    expect(f.referral_to_soc).toBe(0);
  });

  it('handles missing inputs without throwing', () => {
    expect(() => computeFunnel(null, null, 'month', NOW)).not.toThrow();
  });
});

// ─── rankAccountsByPipeline ──────────────────────────────────────

describe('rankAccountsByPipeline', () => {
  const accounts = [
    { id: 'A', name: 'Alpha',   account_type: 'facility',     city: 'Irvine',     last_activity_at: dayAgo(2)  },
    { id: 'B', name: 'Bravo',   account_type: 'facility',     city: 'Newport',    last_activity_at: dayAgo(2)  },
    { id: 'C', name: 'Charlie', account_type: 'professional', city: 'Costa Mesa', last_activity_at: dayAgo(40) },
  ];
  const activities = [
    { account_id: 'A', activity_type: 'visit', occurred_at: dayAgo(2), spend_cents:    0 },
    { account_id: 'A', activity_type: 'visit', occurred_at: dayAgo(3), spend_cents: 1500 },
    { account_id: 'B', activity_type: 'call',  occurred_at: dayAgo(1), spend_cents:    0 },
  ];
  const referrals = [
    { account_id: 'A', referred_at: dayAgo(2), soc_at: dayAgo(1), lost_at: null },
    { account_id: 'B', referred_at: dayAgo(2), soc_at: null,      lost_at: null },
  ];

  it('counts per-account visits/calls/referrals/socs/spend in window', () => {
    const ranked = rankAccountsByPipeline(accounts, activities, referrals, 'week', NOW);
    const a = ranked.find((r) => r.account_id === 'A');
    expect(a).toMatchObject({ visits: 2, calls: 0, referrals: 1, socs: 1, spend_cents: 1500 });
    const b = ranked.find((r) => r.account_id === 'B');
    expect(b).toMatchObject({ visits: 0, calls: 1, referrals: 1, socs: 0 });
  });

  it('flags accounts with no last_activity_at within threshold as cold', () => {
    const ranked = rankAccountsByPipeline(accounts, activities, referrals, 'week', NOW);
    expect(ranked.find((r) => r.account_id === 'C')._cold).toBe(true);
    expect(ranked.find((r) => r.account_id === 'A')._cold).toBe(false);
  });

  it('orders accounts by SOCs, then referrals, then visits', () => {
    const ranked = rankAccountsByPipeline(accounts, activities, referrals, 'week', NOW);
    expect(ranked.map((r) => r.account_id)).toEqual(['A', 'B', 'C']);
  });

  it('computes per-account conversion (referrals/visits)', () => {
    const ranked = rankAccountsByPipeline(accounts, activities, referrals, 'week', NOW);
    expect(ranked.find((r) => r.account_id === 'A').conversion).toBeCloseTo(0.5, 5);
  });
});

// ─── lossReasonBreakdown ─────────────────────────────────────────

describe('lossReasonBreakdown', () => {
  it('groups + sorts losses by reason in window', () => {
    const referrals = [
      { lost_at: dayAgo(2),  loss_reason: 'insurance_denied' },
      { lost_at: dayAgo(2),  loss_reason: 'insurance_denied' },
      { lost_at: dayAgo(3),  loss_reason: 'cost' },
      { lost_at: dayAgo(40), loss_reason: 'cost' },                // outside window
      { lost_at: null,        loss_reason: null },                  // not lost
    ];
    const out = lossReasonBreakdown(referrals, 'week', NOW);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ reason: 'insurance_denied', count: 2 });
    expect(out[1]).toMatchObject({ reason: 'cost', count: 1 });
    expect(out[0].pct).toBeCloseTo(2 / 3, 5);
  });

  it('treats null reason as "other"', () => {
    const referrals = [{ lost_at: dayAgo(1), loss_reason: null }];
    const out = lossReasonBreakdown(referrals, 'week', NOW);
    expect(out[0].reason).toBe('other');
    expect(out[0].label).toBe('Other');
  });

  it('returns an empty array when no losses are in window', () => {
    expect(lossReasonBreakdown([], 'week', NOW)).toEqual([]);
  });
});

// ─── coldAccounts ────────────────────────────────────────────────

describe('coldAccounts', () => {
  const accounts = [
    { id: '1', name: 'Warm',    last_activity_at: dayAgo(3)  },
    { id: '2', name: 'Cold',    last_activity_at: dayAgo(45) },
    { id: '3', name: 'Frozen',  last_activity_at: dayAgo(100) },
    { id: '4', name: 'Never',   last_activity_at: null },
  ];

  it('excludes warm accounts and orders never-touched first', () => {
    const out = coldAccounts(accounts, 21, NOW);
    expect(out.map((a) => a.id)).toEqual(['4', '3', '2']);
  });

  it('respects custom thresholds', () => {
    const out = coldAccounts(accounts, 50, NOW);
    expect(out.map((a) => a.id)).toEqual(['4', '3']);
  });
});

// ─── fetchBdFunnelData (with stub client) ───────────────────────

function chainable(result) {
  const c = {
    select() { return c; },
    eq()     { return c; },
    gte()    { return c; },
    then(resolve) { return Promise.resolve(result).then(resolve); },
  };
  return c;
}
function stubSupabase(byTable) {
  return {
    from(table) {
      if (!(table in byTable)) throw new Error(`unexpected table ${table}`);
      return chainable(byTable[table]);
    },
  };
}

describe('fetchBdFunnelData', () => {
  it('returns empty arrays + null error when supabase missing', async () => {
    const r = await fetchBdFunnelData(null);
    expect(r.error).toBe(null);
    expect(r.data).toEqual({ accounts: [], activities: [], referrals: [] });
  });

  it('fans out three reads in parallel and returns them together', async () => {
    const stub = stubSupabase({
      bd_accounts:   { data: [{ id: 'A', name: 'Hoag', is_active: true }], error: null },
      bd_activities: { data: [{ account_id: 'A', activity_type: 'visit', occurred_at: dayAgo(1) }], error: null },
      bd_referrals:  { data: [{ account_id: 'A', referred_at: dayAgo(2) }], error: null },
    });
    const r = await fetchBdFunnelData(stub);
    expect(r.error).toBe(null);
    expect(r.data.accounts.length).toBe(1);
    expect(r.data.activities.length).toBe(1);
    expect(r.data.referrals.length).toBe(1);
  });

  it('surfaces the first table error', async () => {
    const err = new Error('rls');
    const stub = stubSupabase({
      bd_accounts:   { data: null, error: err },
      bd_activities: { data: [], error: null },
      bd_referrals:  { data: [], error: null },
    });
    const r = await fetchBdFunnelData(stub);
    expect(r.error).toBe(err);
  });
});
