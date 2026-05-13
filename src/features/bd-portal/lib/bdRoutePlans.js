// Manual route builder — data-layer helpers.
//
// Stops are stored on bd_route_plans.stops as a JSONB array of
// { account_id, position }. Position is redundant with array index
// today; we keep it explicit so a future drag-and-drop UI can ship
// reordering without rewriting the whole array atomically.
//
// All helpers in this file are pure (no React, no Supabase) except
// the four Supabase fetchers at the bottom, which take an injected
// client so the same module unit-tests cleanly with a stubbed client.

const STATUS_ACTIVE = 'active';

// ─── Date helpers ─────────────────────────────────────────────────

// Builds today's date in the rep's local timezone as an ISO date
// (YYYY-MM-DD). The route plan key is a calendar date — we want
// "today" to flip when the rep's clock crosses midnight, not when
// UTC midnight passes (which is mid-afternoon in PST).
export function todayLocalIsoDate(now = new Date()) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── Stops shape ──────────────────────────────────────────────────

// Defensive coercion — clamps a raw JSONB value into the shape we
// expect downstream. Drops entries that aren't well-formed objects
// with an account_id. Renumbers positions to be contiguous starting
// at zero so reorder math stays predictable regardless of what was
// in the database.
export function normalizeStops(rawStops) {
  const arr = Array.isArray(rawStops) ? rawStops : [];
  return arr
    .filter((s) => s && typeof s === 'object' && typeof s.account_id === 'string' && s.account_id.length > 0)
    .map((s, i) => ({ account_id: s.account_id, position: i }));
}

export function planHasStop(stops, accountId) {
  return normalizeStops(stops).some((s) => s.account_id === accountId);
}

export function addStopToPlan(stops, accountId) {
  const list = normalizeStops(stops);
  if (!accountId) return list;
  if (list.some((s) => s.account_id === accountId)) return list;
  return [...list, { account_id: accountId, position: list.length }];
}

export function removeStopFromPlan(stops, accountId) {
  const list = normalizeStops(stops);
  return list
    .filter((s) => s.account_id !== accountId)
    .map((s, i) => ({ account_id: s.account_id, position: i }));
}

// Direction is -1 (up / earlier in the route) or +1 (down / later).
// Out-of-bounds moves are no-ops so the UI can bind both buttons
// unconditionally and let this function decide what to do.
export function moveStop(stops, accountId, direction) {
  const list = normalizeStops(stops);
  const i = list.findIndex((s) => s.account_id === accountId);
  if (i === -1) return list;
  const j = i + direction;
  if (j < 0 || j >= list.length) return list;
  const out = list.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out.map((s, k) => ({ account_id: s.account_id, position: k }));
}

// Resolves stop refs against the live accounts list, dropping any
// whose account no longer exists (e.g. it was archived since the
// plan was saved). Returns the trimmed list plus the count we
// dropped so the UI can surface "2 stops were removed because the
// account is no longer active" rather than silently swallow.
export function pruneStopsAgainstAccounts(stops, accounts) {
  const list = normalizeStops(stops);
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { stops: list, dropped: 0 };
  }
  const accountIds = new Set(accounts.map((a) => a?.id).filter(Boolean));
  const kept = list.filter((s) => accountIds.has(s.account_id));
  return {
    stops: kept.map((s, i) => ({ account_id: s.account_id, position: i })),
    dropped: list.length - kept.length,
  };
}

// Joins stops to full account rows in route order so the UI can
// render names/addresses without a second query. Stops referencing
// unknown accounts are skipped (they should have been pruned at
// load time, but this guards the render path too).
export function hydrateStops(stops, accounts) {
  const list = normalizeStops(stops);
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const byId = new Map(accounts.map((a) => [a?.id, a]));
  return list
    .map((s) => {
      const a = byId.get(s.account_id);
      return a ? { account: a, position: s.position } : null;
    })
    .filter(Boolean);
}

// ─── Supabase fetchers ────────────────────────────────────────────

// Returns the rep's active plan for the given date, or { data: null }
// if no plan exists yet. The frontend treats "no plan" as the
// "build one" state — it does not auto-create on mount.
export async function fetchActiveRoutePlan(supabase, ownerUserId, planDate) {
  if (!supabase || !ownerUserId || !planDate) return { data: null, error: null };
  const { data, error } = await supabase
    .from('bd_route_plans')
    .select('id, org_id, owner_user_id, plan_date, name, stops, status, created_at, updated_at')
    .eq('owner_user_id', ownerUserId)
    .eq('plan_date',     planDate)
    .eq('status',        STATUS_ACTIVE)
    .maybeSingle();
  if (error) return { data: null, error };
  return { data: data ?? null, error: null };
}

// Inserts a new empty active plan for the given date. Returns the
// new row. The unique partial index guarantees only one active plan
// per (org, user, date), so concurrent calls hit a duplicate-key
// error rather than silently creating two — callers should refetch
// via fetchActiveRoutePlan on conflict.
export async function createRoutePlan(supabase, ownerUserId, planDate, { name = null, stops = [] } = {}) {
  if (!supabase || !ownerUserId || !planDate) {
    return { data: null, error: new Error('createRoutePlan: missing supabase/ownerUserId/planDate') };
  }
  const payload = {
    owner_user_id: ownerUserId,
    plan_date:     planDate,
    name,
    stops:         normalizeStops(stops),
    status:        STATUS_ACTIVE,
  };
  return await supabase
    .from('bd_route_plans')
    .insert(payload)
    .select('id, org_id, owner_user_id, plan_date, name, stops, status, created_at, updated_at')
    .single();
}

// Writes the full stops array to an existing plan. We don't merge
// or patch — the caller passes the canonical list. Returns the
// updated row.
export async function updateRoutePlanStops(supabase, planId, stops) {
  if (!supabase || !planId) {
    return { data: null, error: new Error('updateRoutePlanStops: missing supabase/planId') };
  }
  return await supabase
    .from('bd_route_plans')
    .update({ stops: normalizeStops(stops) })
    .eq('id', planId)
    .select('id, stops, updated_at')
    .single();
}

// Archives the plan instead of hard-deleting so the audit trail
// survives. The active-per-day unique index ignores archived rows,
// so the rep can build a fresh plan for the same date immediately.
export async function archiveRoutePlan(supabase, planId) {
  if (!supabase || !planId) {
    return { data: null, error: new Error('archiveRoutePlan: missing supabase/planId') };
  }
  return await supabase
    .from('bd_route_plans')
    .update({ status: 'archived' })
    .eq('id', planId)
    .select('id, status, updated_at')
    .single();
}
