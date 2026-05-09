// BD data-layer helpers. Pure functions and Supabase fetchers, kept
// separate from React so they can be unit-tested with a mocked client.
//
// Phase 1 PR #1 scope: list accounts with their last_activity_at and
// activity counts; sort/filter for the Today screen and Account list.
// All reads are org-scoped through the existing Supabase RLS policies
// — the caller must already be authenticated via the portal session.

const COLD_THRESHOLD_DAYS = 21;

export function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function isCold(account, now = Date.now()) {
  const d = daysSince(account?.last_activity_at, now);
  return d === null || d >= COLD_THRESHOLD_DAYS;
}

// Accounts ranked for the Today screen's "who to visit next" suggestion.
// Heuristic v0 (will be replaced by AI route ranking in PR #3):
//   - Recency penalty: more days since last visit = higher priority.
//   - Activity weight: more total touchpoints = stronger relationship,
//     more worth maintaining.
//   - Cold accounts bubble above warm ones.
export function rankAccounts(accounts, now = Date.now()) {
  return [...(accounts ?? [])]
    .map((a) => {
      const d = daysSince(a.last_activity_at, now);
      const cold = d === null || d >= COLD_THRESHOLD_DAYS;
      const recency = d === null ? 365 : d;
      const score = recency + (cold ? 50 : 0) + Math.min(a.activity_count ?? 0, 20);
      return { ...a, _days_since: d, _cold: cold, _score: score };
    })
    .sort((x, y) => y._score - x._score);
}

export function searchAccounts(accounts, term) {
  if (!term) return accounts;
  const q = term.trim().toLowerCase();
  if (!q) return accounts;
  return accounts.filter((a) => {
    const name = (a.name ?? '').toLowerCase();
    const city = (a.city ?? '').toLowerCase();
    return name.includes(q) || city.includes(q);
  });
}

// Builds a Today-screen counter object from the in-memory account
// + activity slice. Stays a pure function so the Today component can
// stay dumb and the rendering is trivially testable.
export function summarizeWeek(activities, now = Date.now()) {
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  let visits = 0;
  let calls = 0;
  let dropOffs = 0;
  let other = 0;
  for (const a of activities ?? []) {
    const t = new Date(a.occurred_at).getTime();
    if (Number.isNaN(t) || t < weekAgo) continue;
    if (a.activity_type === 'visit') visits += 1;
    else if (a.activity_type === 'call') calls += 1;
    else if (a.activity_type === 'drop_off') dropOffs += 1;
    else other += 1;
  }
  return { visits, calls, dropOffs, other, total: visits + calls + dropOffs + other };
}

// ─── Supabase fetchers ──────────────────────────────────────────────
//
// These take an injected `supabase` client so the same module can be
// used in tests with a stub. They return { data, error } shaped like
// the supabase-js calls themselves so callers can pass results through
// without re-shaping.

export async function fetchAccountsWithActivity(supabase) {
  if (!supabase) return { data: [], error: null };

  const accountsRes = await supabase
    .from('bd_accounts')
    .select('id, name, account_type, facility_subtype, professional_subtype, city, state, notes, out_of_territory, tier_override, last_activity_at')
    .eq('is_active', true)
    .order('name', { ascending: true });
  if (accountsRes.error) return { data: [], error: accountsRes.error };
  const accounts = accountsRes.data ?? [];
  if (accounts.length === 0) return { data: [], error: null };

  // Pull activity counts in a single grouped query. Supabase doesn't
  // expose GROUP BY through the JS client, but `select('account_id')`
  // on bd_activities returns the raw rows and we count client-side.
  // 340 rows today; fine to do in JS.
  const ids = accounts.map((a) => a.id);
  const activityRes = await supabase
    .from('bd_activities')
    .select('account_id, occurred_at, activity_type')
    .in('account_id', ids);
  if (activityRes.error) return { data: [], error: activityRes.error };

  const counts = new Map();
  for (const a of activityRes.data ?? []) {
    counts.set(a.account_id, (counts.get(a.account_id) ?? 0) + 1);
  }

  const enriched = accounts.map((a) => ({
    ...a,
    activity_count: counts.get(a.id) ?? 0,
  }));

  return { data: enriched, error: null, _allActivities: activityRes.data ?? [] };
}
