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

// A "prospect" is an account we imported from territory research that
// we've never actually engaged. Distinct from "cold" (which means we
// engaged previously but haven't recently). The badge lets the rep tell
// at a glance whether a row needs a first-touch outreach (Prospect) or
// a re-engagement (Cold).
//
// Two conditions:
//   1. source = 'research_import' — the row came from a bulk research
//      import rather than manual entry or an actual referral.
//   2. activity_count is 0 — no calls/visits/emails/drop-offs logged.
//      Once the rep logs anything against the account it stops being
//      a prospect (it's now an engaged-but-quiet account).
//
// Pre-existing source values ('manual', 'trello_import', null on legacy
// rows from before the column shipped) are never prospects.
export function isProspect(account) {
  if (!account || account.source !== 'research_import') return false;
  return (account.activity_count ?? 0) === 0;
}

// Accounts ranked for the Today screen's "who to visit next" suggestion.
// Heuristic v0 (will be replaced by AI route ranking in PR #3):
//   - Recency penalty: more days since last visit = higher priority.
//   - Activity weight: more total touchpoints = stronger relationship,
//     more worth maintaining.
//   - Cold accounts bubble above warm ones.
//   - Prospects (research_import + zero activity) get a small bump so
//     they appear above warm accounts but BELOW true cold ones. Cold
//     accounts represent dormant relationships that decay if ignored;
//     prospects are an untapped pool that grows when worked. We
//     deliberately prioritize re-engaging real relationships over
//     cold-calling a fresh list.
//   - Starred accounts (the rep's personal shortlist via
//     bd_account_stars) get a strong score boost so they bubble to
//     the top of the Today screen ahead of generic cold accounts.
//     Pass a Set of starred account ids in `opts.starredIds`; an
//     empty set is the default and behaves identically to the prior
//     unstarred ranking.
export function rankAccounts(accounts, now = Date.now(), opts = {}) {
  const starredIds = opts.starredIds instanceof Set ? opts.starredIds : new Set();
  return [...(accounts ?? [])]
    .map((a) => {
      const d = daysSince(a.last_activity_at, now);
      const cold = d === null || d >= COLD_THRESHOLD_DAYS;
      const prospect = isProspect(a);
      const starred = starredIds.has(a.id);
      const recency = d === null ? 365 : d;
      // Prospect score: ~25 (between warm and cold). Cold gets +50.
      // Prospects without `last_activity_at` would otherwise score 365
      // via the null recency fallback — clamp to keep them below cold.
      const recencyAdjusted = prospect ? 25 : recency;
      // Star bonus: +500. Hard tier — always sorts above unstarred
      // because the rep's personal shortlist is what drives her day.
      // Max possible non-star score is ~recency(365) + cold(50) +
      // activity(20) = 435, so +500 reliably dominates. Within
      // starred accounts, recency + cold bonus still drive ordering,
      // so a starred-but-dormant account sits at the top of the
      // shortlist.
      const starBonus = starred ? 500 : 0;
      const score = recencyAdjusted + (cold && !prospect ? 50 : 0) + starBonus + Math.min(a.activity_count ?? 0, 20);
      return { ...a, _days_since: d, _cold: cold && !prospect, _prospect: prospect, _starred: starred, _score: score };
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

// ─── Territory filtering ───────────────────────────────────────────
//
// A rep's default view is "accounts in my territory ∪ accounts flagged
// strategic." Strategic-shared rows are visible to every rep regardless
// of city because they're large health systems (Hoag, Mission, UCI,
// Providence/St Joe's) that the whole BD team coordinates with.
//
// Matching is case-insensitive on trimmed city strings. Both formal
// and shorthand city variants ("Rancho Mission Viejo", "RMV") are
// expected to be listed in the territory's cities[] so historical
// Trello-imported rows match without a city-normalization backfill.

export function normalizeCityForMatch(s) {
  return (s ?? '').toString().trim().toLowerCase();
}

export function filterToTerritory(accounts, territoryCities) {
  const list = Array.isArray(accounts) ? accounts : [];
  const cities = Array.isArray(territoryCities) ? territoryCities : [];
  // Empty territory == no filter (admin view, or a rep with no
  // territory assignment yet — they shouldn't be silently hidden from
  // every account in the org). Strategic-only filtering would be
  // surprising, so we no-op instead.
  if (cities.length === 0) return list;
  const cityset = new Set(cities.map(normalizeCityForMatch));
  return list.filter((a) => {
    if (a?.is_strategic_shared === true) return true;
    return cityset.has(normalizeCityForMatch(a?.city));
  });
}

// Pulls the union of cities across every territory the current user
// belongs to in their current org. Resolves through the SECURITY
// DEFINER RPC introduced in migration 20260513140000 so the matching
// rule lives in one place. Returns [] on failure so the UI degrades to
// "show everything" rather than hiding accounts mid-session.
export async function fetchCurrentUserTerritoryCities(supabase) {
  if (!supabase) return { data: [], error: null };
  const res = await supabase.rpc('bd_current_user_territory_cities');
  if (res.error) return { data: [], error: res.error };
  return { data: Array.isArray(res.data) ? res.data : [], error: null };
}

// Pulls the current user's starred account ids. Returns a Set for
// O(1) lookup at render time. RLS scopes the query to the caller's
// own rows, so we don't pass user_id explicitly. Returns an empty Set
// on error so the UI degrades to "no stars" rather than failing the
// list — the star button still works on tap to retry.
export async function fetchCurrentUserStarredAccountIds(supabase) {
  if (!supabase) return { data: new Set(), error: null };
  const res = await supabase
    .from('bd_account_stars')
    .select('account_id');
  if (res.error) return { data: new Set(), error: res.error };
  const ids = (res.data ?? []).map((r) => r.account_id);
  return { data: new Set(ids), error: null };
}

// Pulls the starred account ids for an *explicit* user. Used by the
// view-as flow: a normal rep passes their own id (identical result to
// fetchCurrentUserStarredAccountIds under RLS), and an owner auditing a
// rep passes that rep's id. The explicit `.eq('user_id', …)` filter is
// load-bearing — once the owner read-override SELECT policy is in place
// (migration 20260602000000), an unfiltered query would return *every*
// rep's stars merged together for an owner. Returns an empty Set when no
// userId is known yet (session still resolving) so we never fetch the
// whole org's stars by accident.
export async function fetchStarredAccountIdsForUser(supabase, userId) {
  if (!supabase || !userId) return { data: new Set(), error: null };
  const res = await supabase
    .from('bd_account_stars')
    .select('account_id')
    .eq('user_id', userId);
  if (res.error) return { data: new Set(), error: res.error };
  const ids = (res.data ?? []).map((r) => r.account_id);
  return { data: new Set(ids), error: null };
}

// Pulls the territory cities for an explicit user via the parameterized
// SECURITY DEFINER RPC (migration 20260602000000). The RPC returns the
// target's cities only when the caller is the target or an owner; anyone
// else gets []. When no userId is supplied we fall back to the legacy
// self-scoped RPC so callers outside the view-as flow keep working
// unchanged. Returns [] on failure so the UI degrades to "show
// everything" rather than hiding accounts mid-session.
export async function fetchTerritoryCitiesForUser(supabase, userId) {
  if (!supabase) return { data: [], error: null };
  const res = userId
    ? await supabase.rpc('bd_territory_cities_for_user', { p_user_id: userId })
    : await supabase.rpc('bd_current_user_territory_cities');
  if (res.error) return { data: [], error: res.error };
  return { data: Array.isArray(res.data) ? res.data : [], error: null };
}

// Lists the BD reps an owner may audit (territory members in the org,
// minus the caller). Returns [] for non-owners — the RPC itself gates on
// is_owner(), so a non-owner gets zero rows and the picker stays hidden.
// Rows are { user_id, email, full_name }. Returns [] on error so a
// transient failure just hides the picker rather than breaking the
// portal.
export async function fetchAuditableReps(supabase) {
  if (!supabase) return { data: [], error: null };
  const res = await supabase.rpc('bd_list_auditable_reps');
  if (res.error) return { data: [], error: res.error };
  return { data: Array.isArray(res.data) ? res.data : [], error: null };
}

// Resolves the *effective* rep identity the Today-screen briefing should
// be scoped to. Mirrors the view-as resolution in useBdWeekRecap so the
// briefing narrative, the week counters it cites, and the Top-5 list all
// describe the same person:
//   - normal rep  → their own session identity,
//   - owner audit → the rep they're viewing-as (from the auditable-reps
//     RPC row, which carries { user_id, email, full_name }).
//
// Returns:
//   - name:               friendly display name for the greeting. Prefers
//                         full_name, falls back to the email local-part,
//                         then a generic stand-in — same precedence the
//                         rest of the portal uses (see BDApp).
//   - userId:             the effective user id. The edge function passes
//                         this to bd_territory_cities_for_user so the
//                         account totals / cold count / suggested visits
//                         are scoped to that rep's territory.
//   - createdByCandidates: the strings bd_activities.created_by may hold
//                         for this rep (full_name AND email, since
//                         useBdLogActivity prefers full_name but older
//                         rows fall back to email). The edge function
//                         filters the week counters by these so they
//                         count the rep's own work — including any
//                         out-of-territory activity.
//
// Pure so it can be unit-tested without a live session.
export function resolveBriefingIdentity({ sessionUser, isViewingAs, effectiveRep, effectiveUserId } = {}) {
  const emailLocalPart = (email) => (email ? String(email).split('@')[0] : null);

  if (isViewingAs && effectiveRep) {
    const fullName = effectiveRep.full_name || null;
    const email = effectiveRep.email || null;
    return {
      name: fullName || emailLocalPart(email) || 'there',
      userId: effectiveUserId ?? effectiveRep.user_id ?? null,
      createdByCandidates: [fullName, email].filter(Boolean),
    };
  }

  const fullName = sessionUser?.user_metadata?.full_name || null;
  const email = sessionUser?.email || null;
  return {
    name: fullName || emailLocalPart(email) || 'there',
    userId: sessionUser?.id ?? null,
    createdByCandidates: [fullName, email].filter(Boolean),
  };
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
    .select('id, name, account_type, facility_subtype, professional_subtype, address, city, state, zip, lat, lng, notes, out_of_territory, is_strategic_shared, tier_override, last_activity_at, source')
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

// ─── Account profile fetchers ──────────────────────────────────────
//
// Three small, single-table reads. Kept as separate functions so the
// hook can fan them out in parallel — total round-trip is one round-
// trip's worth instead of three.

export async function fetchAccount(supabase, accountId) {
  if (!supabase || !accountId) return { data: null, error: null };
  return await supabase
    .from('bd_accounts')
    .select('id, name, account_type, facility_subtype, professional_subtype, address, city, state, zip, phone, website, notes, is_active, out_of_territory, is_strategic_shared, tier_override, last_activity_at, created_at, source')
    .eq('id', accountId)
    .single();
}

export async function fetchAccountContacts(supabase, accountId) {
  if (!supabase || !accountId) return { data: [], error: null };
  return await supabase
    .from('bd_account_contacts')
    .select('id, name, title, role, email, phone_mobile, phone_office, notes, is_primary, is_active, last_activity_at')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('is_primary', { ascending: false })
    .order('name',       { ascending: true });
}

export async function fetchAccountActivities(supabase, accountId, { limit = 200 } = {}) {
  if (!supabase || !accountId) return { data: [], error: null };
  return await supabase
    .from('bd_activities')
    .select('id, activity_type, occurred_at, duration_minutes, spend_cents, spend_category, notes, source, created_by, contact_id')
    .eq('account_id', accountId)
    .order('occurred_at', { ascending: false })
    .limit(limit);
}

// ─── Display helpers ───────────────────────────────────────────────

export const ACTIVITY_TYPE_LABELS = {
  visit:             'Visit',
  call:              'Call',
  email:             'Email',
  sms:               'Text',
  drop_off:          'Drop-off',
  event:             'Event',
  referral_received: 'Referral',
  note:              'Note',
};

export function formatActivityDate(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - day.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0)  return 'Today';
  if (diffDays === 1)  return 'Yesterday';
  if (diffDays < 7)    return `${diffDays} days ago`;
  // Same calendar year → omit the year.
  if (day.getFullYear() === today.getFullYear()) {
    return day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Geofence + route helpers ──────────────────────────────────────
//
// Pure helpers used by the Today screen's "you're near an account"
// banner and the multi-stop route button. Both degrade silently when
// accounts don't yet have lat/lng or street addresses — the rep can
// always log activity through the normal QuickCapture flow regardless.

// Default geofence radius around an account's stored coordinate. 200m
// covers a typical hospital campus / SNF parking lot without falsely
// triggering for accounts on adjacent blocks. Adjustable per-call.
export const DEFAULT_NEARBY_RADIUS_METERS = 200;

// Haversine great-circle distance in meters between two WGS-84 points.
// Cheap enough to run over the full account list (<500 rows) on every
// position update.
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const nums = [lat1, lng1, lat2, lng2];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Returns the closest account to a given position whose stored
// coordinate is within `radiusMeters`, or null if no account qualifies.
// Position is `{ lat, lng }`. Accounts missing lat/lng are silently
// skipped — this is the no-op path when the dataset hasn't been
// geocoded yet.
export function findNearestAccount(accounts, position, { radiusMeters = DEFAULT_NEARBY_RADIUS_METERS } = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  if (!position || typeof position.lat !== 'number' || typeof position.lng !== 'number') return null;
  let best = null;
  for (const a of accounts) {
    if (typeof a?.lat !== 'number' || typeof a?.lng !== 'number') continue;
    const d = haversineMeters(position.lat, position.lng, a.lat, a.lng);
    if (d === null || d > radiusMeters) continue;
    if (!best || d < best.distance_meters) {
      best = { account: a, distance_meters: d };
    }
  }
  return best;
}

// Builds an Apple Maps URL with multiple waypoints. iOS opens it in
// the native Maps app; on macOS Safari it opens maps.apple.com; other
// platforms render a web view that still works. Returns null if none
// of the stops have a usable address — caller should hide the CTA in
// that case rather than open an empty maps link.
//
// Apple's URL scheme accepts `daddr=A+to:B+to:C` for multi-stop. We
// also pass `dirflg=d` (driving) since that's the BD rep's mode.
export function buildAppleMapsRouteUrl(stops, { fromCurrentLocation = true } = {}) {
  if (!Array.isArray(stops)) return null;
  const usable = stops
    .map((s) => formatStopAddress(s))
    .filter((addr) => addr && addr.length > 0);
  if (usable.length === 0) return null;
  const daddr = usable.map(encodeURIComponent).join('+to:');
  const params = [`daddr=${daddr}`, 'dirflg=d'];
  if (fromCurrentLocation) {
    // Apple Maps interprets an empty saddr as "current location".
    params.unshift('saddr=Current+Location');
  }
  return `https://maps.apple.com/?${params.join('&')}`;
}

// Joins an account's structured address into a single string suitable
// for a maps query. Falls back to name + city if no street address is
// set so a partially-populated account still gets a reasonable pin.
// Returns null if the account has neither.
export function formatStopAddress(account) {
  if (!account || typeof account !== 'object') return null;
  const parts = [];
  // Lead with the street address when present; otherwise fall back to
  // the account name so a name+city query still pins the right place.
  if (account.address) {
    parts.push(account.address);
  } else if (account.name) {
    parts.push(account.name);
  }
  const cityState = [account.city, account.state].filter(Boolean).join(', ');
  if (cityState) parts.push(cityState);
  if (account.zip) parts.push(String(account.zip));
  return parts.length > 0 ? parts.join(', ') : null;
}

// True when an account has enough geo info to appear on a route plan.
// We accept a street address OR a name + city pair so older accounts
// with only the Trello-imported `city` still participate.
export function hasRoutableAddress(account) {
  if (!account) return false;
  if (account.address) return true;
  return Boolean(account.name && account.city);
}

// True when an account has a precise coordinate. Used by the geofence
// banner — we only trigger nearby alerts on real lat/lng, never on a
// city-only fallback (too imprecise to be useful at 200m).
export function hasPreciseCoordinate(account) {
  return Boolean(
    account &&
    typeof account.lat === 'number' && Number.isFinite(account.lat) &&
    typeof account.lng === 'number' && Number.isFinite(account.lng),
  );
}

export function formatAccountSubtitle(account) {
  if (!account) return '';
  const kind =
    account.account_type === 'professional'
      ? (account.professional_subtype ?? 'Professional')
      : (account.facility_subtype ?? 'Facility');
  const place = [account.city, account.state].filter(Boolean).join(', ');
  return [kind, place].filter(Boolean).join(' · ');
}
