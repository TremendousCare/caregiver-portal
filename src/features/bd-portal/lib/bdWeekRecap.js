// Weekly recap helpers — pure functions. Mirrors the design of
// bdRoutePlans / bdQueries: no React, no Supabase. The hook does the
// fetches and feeds these helpers the resulting in-memory arrays.
//
// Week is Mon–Sun in the rep's local timezone. The shared data shape
// is:
//   plans       — array of bd_route_plans rows (plan_date is a YYYY-MM-DD string)
//   activities  — array of bd_activities rows (occurred_at is an ISO timestamp)
//   accounts    — array of bd_accounts rows (used to hydrate names)

// ─── Date math ────────────────────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Produce YYYY-MM-DD using local fields. Same convention as
// todayLocalIsoDate in bdRoutePlans.js — we treat the rep's wall-clock
// date as the source of truth.
export function localIsoDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// Convert a timestamp (ISO string or Date) into the YYYY-MM-DD it
// falls on in the rep's local timezone. Used to bucket activities by
// day for the day-strip counters.
export function localIsoDateFromTimestamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return localIsoDate(d);
}

// Add `n` calendar days to a YYYY-MM-DD string. Goes through a Date
// object built from local fields so DST transitions don't shift the
// result by an hour and cross a midnight boundary.
export function addDaysIso(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return localIsoDate(dt);
}

// Mon–Sun range containing `date`. Returns { start, end, dates[7] }
// where each entry is a YYYY-MM-DD string in local time.
// getDay() is 0=Sun..6=Sat; offset to Mon is (day + 6) % 7.
export function getWeekRange(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const offsetToMonday = (d.getDay() + 6) % 7;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offsetToMonday);
  const startIso = localIsoDate(start);
  const dates = Array.from({ length: 7 }, (_, i) => addDaysIso(startIso, i));
  return { start: startIso, end: dates[6], dates };
}

// ─── Display helpers ──────────────────────────────────────────────

const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAY  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseLocal(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatShortDay(isoDate) {
  const d = parseLocal(isoDate);
  return SHORT_DAY[d.getDay()];
}

export function formatShortDate(isoDate) {
  const d = parseLocal(isoDate);
  return `${SHORT_MONTH[d.getMonth()]} ${d.getDate()}`;
}

export function formatDayHeader(isoDate) {
  const d = parseLocal(isoDate);
  return `${LONG_DAY[d.getDay()]}, ${SHORT_MONTH[d.getMonth()]} ${d.getDate()}`;
}

export function formatWeekRange({ start, end }) {
  const s = parseLocal(start);
  const e = parseLocal(end);
  if (s.getMonth() === e.getMonth()) {
    return `${SHORT_MONTH[s.getMonth()]} ${s.getDate()} – ${e.getDate()}, ${e.getFullYear()}`;
  }
  // Spans a month boundary: "Apr 28 – May 4, 2026".
  return `${SHORT_MONTH[s.getMonth()]} ${s.getDate()} – ${SHORT_MONTH[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
}

// ─── Grouping ─────────────────────────────────────────────────────

// Returns Map<isoDate, activity[]>. Activities whose occurred_at falls
// outside the week are dropped silently (the hook fetches with a date
// filter, this is belt-and-suspenders). Activities within a day are
// returned in chronological order (earliest first) so the day-detail
// list reads like a timeline.
export function groupActivitiesByDay(activities, weekDates) {
  const out = new Map();
  if (Array.isArray(weekDates)) {
    for (const iso of weekDates) out.set(iso, []);
  }
  for (const act of activities ?? []) {
    const iso = localIsoDateFromTimestamp(act?.occurred_at);
    if (!iso) continue;
    if (!out.has(iso)) continue;
    out.get(iso).push(act);
  }
  for (const list of out.values()) {
    list.sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  }
  return out;
}

// Returns Map<isoDate, plan>. Only active plans are considered — the
// hook's query already filters status='active', but we defend here too.
export function groupPlansByDay(plans) {
  const out = new Map();
  for (const p of plans ?? []) {
    if (!p?.plan_date) continue;
    if (p.status && p.status !== 'active') continue;
    out.set(p.plan_date, p);
  }
  return out;
}

// ─── Plan vs actual ───────────────────────────────────────────────

// Compares a day's planned stops to actual activities logged that day.
// A planned stop counts as completed if there is ANY activity that day
// against that account — type doesn't matter. Loose match because the
// rep may have planned to visit but ended up calling instead, and we
// don't want to penalize her in the recap for changing tactics.
//
// Returns:
//   {
//     planned:   [{ account_id, position, activities: [...], completed: bool }],
//     unplanned: [...activities not matching any planned stop]
//   }
// The `planned` array preserves the plan's stop order. Activities are
// the chronologically-sorted day-bucket from groupActivitiesByDay.
export function matchPlanToActuals(planStops, dayActivities) {
  const stops = Array.isArray(planStops) ? planStops : [];
  const acts  = Array.isArray(dayActivities) ? dayActivities : [];

  // Index planned account ids so unplanned-detection is O(activities).
  const plannedIds = new Set(stops.map((s) => s?.account_id).filter(Boolean));

  // Bucket activities by their account id.
  const byAccount = new Map();
  for (const a of acts) {
    if (!a?.account_id) continue;
    if (!byAccount.has(a.account_id)) byAccount.set(a.account_id, []);
    byAccount.get(a.account_id).push(a);
  }

  const planned = stops
    .filter((s) => s && typeof s.account_id === 'string')
    .map((s) => {
      const activities = byAccount.get(s.account_id) ?? [];
      return {
        account_id: s.account_id,
        position:   typeof s.position === 'number' ? s.position : 0,
        activities,
        completed:  activities.length > 0,
      };
    });

  const unplanned = acts.filter((a) => !plannedIds.has(a?.account_id));

  return { planned, unplanned };
}

// ─── Counters ─────────────────────────────────────────────────────

// Buckets a day's activities by type. Returns a flat object so the
// callsite can pick whichever counters it wants to display.
export function computeDayCounters(dayActivities) {
  let visits    = 0;
  let calls     = 0;
  let emails    = 0;
  let sms       = 0;
  let dropOffs  = 0;
  let events    = 0;
  let referrals = 0;
  let notes     = 0;
  let other     = 0;
  for (const a of dayActivities ?? []) {
    switch (a?.activity_type) {
      case 'visit':             visits    += 1; break;
      case 'call':              calls     += 1; break;
      case 'email':             emails    += 1; break;
      case 'sms':               sms       += 1; break;
      case 'drop_off':          dropOffs  += 1; break;
      case 'event':             events    += 1; break;
      case 'referral_received': referrals += 1; break;
      case 'note':              notes     += 1; break;
      default:                  other     += 1; break;
    }
  }
  const total = visits + calls + emails + sms + dropOffs + events + referrals + notes + other;
  return { visits, calls, emails, sms, dropOffs, events, referrals, notes, other, total };
}

// One day's worth of recap data, computed from the per-day plan +
// activity slices. Used by the day-strip (top-level counters + ratio)
// and the day-detail view (full plan-vs-actual breakdown).
export function computeDaySummary({ plan, activities }) {
  const planStops  = Array.isArray(plan?.stops) ? plan.stops : [];
  const { planned, unplanned } = matchPlanToActuals(planStops, activities);
  const counters = computeDayCounters(activities);
  const completed = planned.filter((p) => p.completed).length;
  return {
    counters,
    planTotal:     planStops.length,
    planCompleted: completed,
    planMissed:    planStops.length - completed,
    unplannedCount: unplanned.length,
    planned,
    unplanned,
  };
}

// Week-wide rollup for the summary header. Sums per-day counters and
// totals the planned/completed/missed counts across the week.
export function computeWeekSummary({ plans, activities, weekDates }) {
  const byDay   = groupActivitiesByDay(activities, weekDates);
  const byPlan  = groupPlansByDay(plans);
  const touchedAccountIds = new Set();
  let totalActivities = 0;
  let totalSpendCents = 0;
  let totalPlanned    = 0;
  let totalCompleted  = 0;
  const totalsByType  = {
    visits: 0, calls: 0, emails: 0, sms: 0,
    dropOffs: 0, events: 0, referrals: 0, notes: 0, other: 0,
  };

  for (const iso of weekDates ?? []) {
    const dayActs  = byDay.get(iso) ?? [];
    const plan     = byPlan.get(iso) ?? null;
    const summary  = computeDaySummary({ plan, activities: dayActs });

    totalPlanned   += summary.planTotal;
    totalCompleted += summary.planCompleted;
    totalActivities += summary.counters.total;
    for (const key of Object.keys(totalsByType)) {
      totalsByType[key] += summary.counters[key];
    }
    for (const a of dayActs) {
      if (a?.account_id) touchedAccountIds.add(a.account_id);
      if (typeof a?.spend_cents === 'number') totalSpendCents += a.spend_cents;
    }
  }

  return {
    totalActivities,
    totalsByType,
    totalAccountsTouched: touchedAccountIds.size,
    totalSpendCents,
    totalPlanned,
    totalCompleted,
    totalMissed: totalPlanned - totalCompleted,
  };
}

// ─── Datetime-local helpers (for backfill) ────────────────────────

// Build a `<input type="datetime-local">` value for noon on the given
// ISO date in the rep's local timezone. Used to prefill QuickCapture
// when she backfills from the recap view — noon is a sensible "during
// the workday" default she can adjust if she remembers the exact time.
export function noonLocalInputForIsoDate(isoDate) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${pad2(y)}-${pad2(m)}-${pad2(d)}T12:00`;
}
