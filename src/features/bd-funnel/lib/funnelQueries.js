// BD funnel report — data layer.
//
// Owner-facing desktop view. Aggregates activities + referrals over a
// selected window into the funnel the rep is measured on:
//
//     Visits  →  Referrals  →  Starts of Care
//
// All aggregation is pure (no Supabase calls) so it's covered by
// unit tests. The single supabase fetcher at the bottom returns the
// raw rows; the React hook composes the two.

export const PERIODS = ['week', 'month', 'quarter', 'year'];
export const PERIOD_LABELS = {
  week:    'Last 7 days',
  month:   'Last 30 days',
  quarter: 'Last 90 days',
  year:    'Last 365 days',
};
const PERIOD_DAYS = { week: 7, month: 30, quarter: 90, year: 365 };
export const COLD_THRESHOLD_DAYS = 21;

export const LOSS_REASON_LABELS = {
  insurance_denied:   'Insurance denied',
  chose_other_agency: 'Chose other agency',
  patient_passed:     'Patient passed',
  did_not_qualify:    'Did not qualify',
  lost_contact:       'Lost contact',
  cost:               'Cost',
  other:              'Other',
};

// ─── Time helpers ───────────────────────────────────────────────

export function periodStart(period, now = Date.now()) {
  const days = PERIOD_DAYS[period] ?? PERIOD_DAYS.month;
  return new Date(now - days * 24 * 60 * 60 * 1000);
}

function inRange(iso, start, end) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t >= start.getTime() && t <= end.getTime();
}

export function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / (1000 * 60 * 60 * 24));
}

function safeDivide(numerator, denominator) {
  if (!denominator) return 0;
  return numerator / denominator;
}

// ─── Top-level funnel ───────────────────────────────────────────

export function computeFunnel(activities, referrals, period, now = Date.now()) {
  const start = periodStart(period, now);
  const end   = new Date(now);

  let visits = 0;
  for (const a of activities ?? []) {
    if (a.activity_type === 'visit' && inRange(a.occurred_at, start, end)) {
      visits += 1;
    }
  }

  let inPeriodReferrals = 0;
  let socs = 0;
  let lost = 0;
  for (const r of referrals ?? []) {
    if (inRange(r.referred_at, start, end)) inPeriodReferrals += 1;
    // SOCs and losses are counted by their *event date* falling in the
    // window — a referral logged in March that closed in April is a
    // loss this month, not last.
    if (r.soc_at && inRange(r.soc_at, start, end)) socs += 1;
    if (r.lost_at && inRange(r.lost_at, start, end)) lost += 1;
  }

  return {
    visits,
    referrals: inPeriodReferrals,
    socs,
    lost,
    visit_to_referral: safeDivide(inPeriodReferrals, visits),
    referral_to_soc:   safeDivide(socs,             inPeriodReferrals),
  };
}

// ─── Per-account ranking ────────────────────────────────────────

export function rankAccountsByPipeline(accounts, activities, referrals, period, now = Date.now()) {
  const start = periodStart(period, now);
  const end   = new Date(now);

  // Index activities + referrals by account_id once.
  const visitsByAccount    = new Map();
  const callsByAccount     = new Map();
  const dropOffsByAccount  = new Map();
  const referralsByAccount = new Map();
  const socsByAccount      = new Map();
  const spendByAccount     = new Map();

  for (const a of activities ?? []) {
    if (!a.account_id) continue;
    if (!inRange(a.occurred_at, start, end)) continue;
    const bump = (m) => m.set(a.account_id, (m.get(a.account_id) ?? 0) + 1);
    if (a.activity_type === 'visit')    bump(visitsByAccount);
    if (a.activity_type === 'call')     bump(callsByAccount);
    if (a.activity_type === 'drop_off') bump(dropOffsByAccount);
    if (a.spend_cents) {
      spendByAccount.set(a.account_id, (spendByAccount.get(a.account_id) ?? 0) + a.spend_cents);
    }
  }

  for (const r of referrals ?? []) {
    if (!r.account_id) continue;
    if (inRange(r.referred_at, start, end)) {
      referralsByAccount.set(r.account_id, (referralsByAccount.get(r.account_id) ?? 0) + 1);
    }
    if (r.soc_at && inRange(r.soc_at, start, end)) {
      socsByAccount.set(r.account_id, (socsByAccount.get(r.account_id) ?? 0) + 1);
    }
  }

  return (accounts ?? []).map((a) => {
    const visits    = visitsByAccount.get(a.id)    ?? 0;
    const calls     = callsByAccount.get(a.id)     ?? 0;
    const dropOffs  = dropOffsByAccount.get(a.id)  ?? 0;
    const refs      = referralsByAccount.get(a.id) ?? 0;
    const socs      = socsByAccount.get(a.id)      ?? 0;
    const spend     = spendByAccount.get(a.id)     ?? 0;
    return {
      account_id: a.id,
      name: a.name,
      account_type: a.account_type,
      facility_subtype: a.facility_subtype,
      city: a.city,
      visits,
      calls,
      drop_offs: dropOffs,
      referrals: refs,
      socs,
      spend_cents: spend,
      conversion: safeDivide(refs, visits),
      last_activity_at: a.last_activity_at,
      _cold: daysSince(a.last_activity_at, now) >= COLD_THRESHOLD_DAYS || a.last_activity_at == null,
    };
  })
  .sort((x, y) => {
    // Primary sort: SOCs (revenue), then referrals (volume), then
    // visits. Accounts with zero activity drop to the bottom.
    if (y.socs       !== x.socs)       return y.socs - x.socs;
    if (y.referrals  !== x.referrals)  return y.referrals - x.referrals;
    return y.visits - x.visits;
  });
}

// ─── Lost-reason breakdown ──────────────────────────────────────

export function lossReasonBreakdown(referrals, period, now = Date.now()) {
  const start = periodStart(period, now);
  const end   = new Date(now);
  const counts = new Map();
  let total = 0;
  for (const r of referrals ?? []) {
    if (!r.lost_at) continue;
    if (!inRange(r.lost_at, start, end)) continue;
    const key = r.loss_reason ?? 'other';
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({
      reason,
      label: LOSS_REASON_LABELS[reason] ?? reason,
      count,
      pct: total ? count / total : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

// ─── Cold-account list ──────────────────────────────────────────

export function coldAccounts(accounts, thresholdDays = COLD_THRESHOLD_DAYS, now = Date.now()) {
  return (accounts ?? [])
    .map((a) => ({ ...a, _days: daysSince(a.last_activity_at, now) }))
    .filter((a) => a._days === null || a._days >= thresholdDays)
    .sort((x, y) => {
      // Never-touched first, then longest-dormant first.
      if (x._days === null && y._days !== null) return -1;
      if (y._days === null && x._days !== null) return  1;
      return (y._days ?? 0) - (x._days ?? 0);
    });
}

// ─── Supabase fetcher ───────────────────────────────────────────
//
// One round-trip per table, returned together. Volumes are small
// (~100 accounts, ~340 activities, near-zero referrals on day one)
// so we can afford to pull everything and aggregate in JS — keeps
// the period filter snappy and avoids three RPCs.

export async function fetchBdFunnelData(supabase, { since } = {}) {
  if (!supabase) return { data: { accounts: [], activities: [], referrals: [] }, error: null };

  const sinceIso = (since instanceof Date ? since : new Date(since ?? Date.now() - 365 * 24 * 60 * 60 * 1000)).toISOString();

  const [accountsRes, activitiesRes, referralsRes] = await Promise.all([
    supabase
      .from('bd_accounts')
      .select('id, name, account_type, facility_subtype, city, last_activity_at, is_active, out_of_territory')
      .eq('is_active', true),
    supabase
      .from('bd_activities')
      .select('id, account_id, activity_type, occurred_at, spend_cents')
      .gte('occurred_at', sinceIso),
    supabase
      .from('bd_referrals')
      .select('id, account_id, contact_id, referred_at, status, loss_reason, soc_at, lost_at, prospective_name, client_id')
      .gte('referred_at', sinceIso),
  ]);

  const error = accountsRes.error || activitiesRes.error || referralsRes.error;
  if (error) {
    return { data: { accounts: [], activities: [], referrals: [] }, error };
  }
  return {
    data: {
      accounts:   accountsRes.data   ?? [],
      activities: activitiesRes.data ?? [],
      referrals:  referralsRes.data  ?? [],
    },
    error: null,
  };
}
