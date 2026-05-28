// Executive task generation — pure logic.
//
// This file lives under src/ (not under supabase/functions/) so vitest
// can exercise it without a Deno runtime. The edge function
// supabase/functions/exec-tasks-generate/index.ts imports from here
// via a relative cross-tree path; the deploy bundler resolves it at
// build time (same pattern as service-plan-extend-ongoing and
// payroll-generate-timesheets).
//
// Two anchor types produce tasks:
//
//   1. lifecycle  (template.anchor_type = 'hire_date')
//      For every active staff_members row whose hire_date is in the
//      generation window (i.e. hire_date + offset_days falls within
//      [today - LOOKBACK_DAYS, today + LOOKAHEAD_DAYS]), produce one
//      exec_tasks row anchored at (staff_email, hire_date) with
//      due_at = hire_date + offset_days @ 09:00 local.
//
//      Idempotency: uq_exec_tasks_lifecycle (template, anchor_staff_email,
//      anchor_date) — the DB rejects duplicates so re-runs are safe.
//
//   2. recurring  (template.anchor_type = 'fixed_date')
//      If template.next_fire_at is in the past or within the lookahead
//      window, produce one exec_tasks row keyed by recurrence_period
//      and bump next_fire_at by recurrence_interval_days.
//
//      Idempotency: uq_exec_tasks_recurring (template, recurrence_period).
//      Even if the next_fire_at advance fails, the partial unique
//      index prevents a duplicate at the same period.

export const DEFAULT_LOOKBACK_DAYS = 30;
export const DEFAULT_LOOKAHEAD_DAYS = 14;
export const DEFAULT_DUE_HOUR_LOCAL = 9; // 09:00 — start of business day

// ─── Date helpers (ISO-strings, no timezone math beyond UTC) ────

export function isoDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function addDays(iso, days) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return isoDate(dt);
}

// Combine an ISO date with the default due hour to produce a
// timestamp the DB can store. Stays in UTC for v1 (the office is in
// US Pacific, but the dashboard groups by date+hour so 09:00 UTC vs
// 09:00 PT only matters when we add per-org timezones in Phase D).
export function buildDueAt(anchorDateIso, offsetDays, hourLocal = DEFAULT_DUE_HOUR_LOCAL) {
  const target = addDays(anchorDateIso, offsetDays);
  if (!target) return null;
  return `${target}T${String(hourLocal).padStart(2, '0')}:00:00Z`;
}

// ─── Lifecycle: hire-date anchored ──────────────────────────────
//
// For one (template, staff_member) pair, decide whether to produce
// an instance now and what its row should look like.
//
// Returns null when the pair is not yet (or no longer) inside the
// generation window — the caller skips silently.

export function planLifecycleInstance({ template, staff, now, lookbackDays, lookaheadDays }) {
  if (!template || template.anchor_type !== 'hire_date') return null;
  if (!template.active) return null;
  if (!staff?.active) return null;
  if (!staff.hire_date) return null;
  if (template.offset_days === null || template.offset_days === undefined) return null;

  const todayIso = isoDate(now);
  const dueIso = addDays(staff.hire_date, template.offset_days);
  if (!dueIso || !todayIso) return null;

  // Is the due date inside [today - lookback, today + lookahead]?
  const earliest = addDays(todayIso, -lookbackDays);
  const latest = addDays(todayIso, lookaheadDays);
  if (dueIso < earliest || dueIso > latest) return null;

  return {
    org_id: template.org_id,
    template_id: template.id,
    title: template.name,
    description: template.description ?? null,
    category: 'lifecycle',
    visibility: template.visibility ?? 'owner',
    assigned_to: template.default_assignee_email ?? staff.manager_email ?? null,
    due_at: buildDueAt(staff.hire_date, template.offset_days),
    urgency: template.default_urgency ?? 'warning',
    anchor_staff_email: staff.email,
    anchor_date: staff.hire_date,
  };
}

// Convenience: full plan for one template + all staff in the org.
// Returns an array of insert payloads (may be empty).
export function planLifecycleBatch({ template, staff, now, lookbackDays, lookaheadDays }) {
  return (staff ?? [])
    .map((s) => planLifecycleInstance({
      template, staff: s, now, lookbackDays, lookaheadDays,
    }))
    .filter(Boolean);
}

// ─── Recurring: fixed-date anchored ─────────────────────────────
//
// Decision logic for one template. Returns:
//   { row, next_fire_at }  — produce row, then bump template.next_fire_at
//   null                   — nothing to do (too early or template inactive)
//
// recurrence_period is a stable string derived from the fire-date.
// Quarterly templates use 'YYYY-Qn'; monthly 'YYYY-MM'; weekly
// 'YYYY-MM-DD' (the Monday of that week); annual 'YYYY'. The cadence
// is read from the template's recurrence_interval_days — we don't
// require a separate "cadence" column. If interval ≈ 7 → weekly,
// ≈ 30 → monthly, ≈ 90 → quarterly, ≈ 365 → annual; everything else
// falls back to a date-anchored period 'YYYY-MM-DD'.

export function inferCadence(intervalDays) {
  if (!intervalDays) return 'date';
  if (intervalDays <= 7) return 'weekly';
  if (intervalDays <= 31) return 'monthly';
  if (intervalDays <= 100) return 'quarterly';
  if (intervalDays >= 200) return 'annual';
  return 'date';
}

export function periodFromDate(iso, cadence) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  switch (cadence) {
    case 'annual':
      return `${y}`;
    case 'quarterly': {
      const q = Math.floor(((m ?? 1) - 1) / 3) + 1;
      return `${y}-Q${q}`;
    }
    case 'monthly':
      return `${y}-${String(m ?? 1).padStart(2, '0')}`;
    case 'weekly': {
      // Use the Monday-of-week as the period key. Saves a per-row
      // mondayOf() call by computing here.
      const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
      const wd = dt.getUTCDay();
      const diff = wd === 0 ? -6 : 1 - wd;
      dt.setUTCDate(dt.getUTCDate() + diff);
      return isoDate(dt);
    }
    default:
      return iso;
  }
}

export function planRecurringInstance({ template, now, lookaheadDays }) {
  if (!template || template.anchor_type !== 'fixed_date') return null;
  if (!template.active) return null;
  if (!template.recurrence_interval_days || template.recurrence_interval_days <= 0) return null;

  // Without an anchor date we cannot compute when to fire next. The
  // owner sets next_fire_at when activating the template via the UI.
  if (!template.next_fire_at) return null;

  const todayIso = isoDate(now);
  const fireIso = isoDate(template.next_fire_at);
  if (!todayIso || !fireIso) return null;

  // Inside lookahead window? Note we DO process overdue templates
  // (next_fire_at in the past) — that's the recovery path when the
  // cron missed a day. The DB unique index dedupes by period so we
  // can't double-create the same row.
  const latest = addDays(todayIso, lookaheadDays);
  if (fireIso > latest) return null;

  const cadence = inferCadence(template.recurrence_interval_days);
  const period = periodFromDate(fireIso, cadence);
  const dueAt = buildDueAt(fireIso, 0);
  const nextFireAt = `${addDays(fireIso, template.recurrence_interval_days)}T${String(DEFAULT_DUE_HOUR_LOCAL).padStart(2, '0')}:00:00Z`;

  return {
    row: {
      org_id: template.org_id,
      template_id: template.id,
      title: template.name,
      description: template.description ?? null,
      category: 'recurring',
      visibility: template.visibility ?? 'owner',
      assigned_to: template.default_assignee_email ?? null,
      due_at: dueAt,
      urgency: template.default_urgency ?? 'warning',
      recurrence_period: period,
    },
    next_fire_at: nextFireAt,
  };
}

// ─── Run summary helpers ────────────────────────────────────────
// The edge function returns one of these per org so the cron history
// is readable. Pure builder so tests can assert shape.

export function emptyRunResult(orgId) {
  return {
    org_id: orgId,
    lifecycle_inserted: 0,
    lifecycle_skipped_existing: 0,
    recurring_inserted: 0,
    recurring_skipped_existing: 0,
    templates_processed: 0,
    staff_processed: 0,
    errors: [],
  };
}
