// Executive dashboard — pure aggregation helpers.
//
// Takes the same data structures the Goals + Tasks queries return
// (goals with nested exec_key_results + exec_goal_checkins; tasks
// with their nested template metadata) and rolls them up into the
// summaries the dashboard widgets render. All side-effect free —
// vitest exercises each helper directly.

import { krProgress, daysSince } from '../../exec-goals/lib/goalsHelpers';

// Tunable thresholds. Centralized so the dashboard, the tests, and
// the watchlist all agree on what "stale" / "at risk" means.
export const STALE_KR_DAYS = 14;
export const DUE_SOON_DAYS = 7;

// ─── Goal summary ─────────────────────────────────────────────
//
// Returns { krCount, achievedCount, avgPct, worstConfidence, atRisk }
// for a single goal. Pure read over the nested KR/checkin data.

export function summarizeGoal(goal) {
  const krs = goal?.exec_key_results ?? [];
  if (krs.length === 0) {
    return {
      krCount: 0, achievedCount: 0, avgPct: null,
      worstConfidence: null, atRisk: false,
    };
  }

  let sumPct = 0;
  let countWithPct = 0;
  let achieved = 0;
  let anyRed = false;
  let anyYellow = false;

  for (const kr of krs) {
    const p = krProgress(kr);
    if (Number.isFinite(p.pct)) {
      sumPct += Math.max(0, Math.min(1, p.pct));
      countWithPct += 1;
    }
    if (p.achieved) achieved += 1;
    if (kr.confidence === 'red') anyRed = true;
    else if (kr.confidence === 'yellow') anyYellow = true;
  }

  const avgPct = countWithPct === 0 ? null : sumPct / countWithPct;
  const worstConfidence = anyRed ? 'red' : anyYellow ? 'yellow' : 'green';
  // At-risk = active goal with any red KR OR average progress below
  // 0.4 (matches the "behind" threshold from krProgress).
  const atRisk = goal?.status === 'active'
    && (anyRed || (Number.isFinite(avgPct) && avgPct < 0.4));

  return {
    krCount: krs.length,
    achievedCount: achieved,
    avgPct,
    worstConfidence,
    atRisk,
  };
}

// ─── Watchlist items ──────────────────────────────────────────

// Flat list of KRs whose last_checked_in_at is null or older than
// STALE_KR_DAYS. Each item is annotated with its parent goal title +
// id so the dashboard can deep-link to the right card on /exec/goals.
export function findStaleKrs(goals, options = {}) {
  const threshold = options.daysThreshold ?? STALE_KR_DAYS;
  const now = options.now ?? new Date();
  const out = [];
  for (const g of goals ?? []) {
    if (g?.status !== 'active') continue;
    for (const kr of g.exec_key_results ?? []) {
      const since = daysSince(kr.last_checked_in_at, now);
      const stale = since === null || since > threshold;
      if (!stale) continue;
      out.push({
        kr_id: kr.id,
        kr_title: kr.title,
        owner_email: kr.owner_email,
        goal_id: g.id,
        goal_title: g.title,
        days_since_checkin: since,
        confidence: kr.confidence,
      });
    }
  }
  // Sort: never-checked-in first, then most-stale first.
  return out.sort((a, b) => {
    if (a.days_since_checkin === null && b.days_since_checkin !== null) return -1;
    if (b.days_since_checkin === null && a.days_since_checkin !== null) return 1;
    return (b.days_since_checkin ?? 0) - (a.days_since_checkin ?? 0);
  });
}

// Active goals where summarizeGoal flags atRisk=true.
export function findAtRiskGoals(goals) {
  const out = [];
  for (const g of goals ?? []) {
    const s = summarizeGoal(g);
    if (s.atRisk) {
      out.push({ goal: g, summary: s });
    }
  }
  return out;
}

// Non-terminal tasks (pending / in_progress) whose due_at is before
// now. Snoozed tasks are intentionally excluded — they're an
// explicit "later" signal.
export function findOverdueTasks(tasks, now = new Date()) {
  const out = [];
  for (const t of tasks ?? []) {
    if (!['pending', 'in_progress'].includes(t.status)) continue;
    if (!t.due_at) continue;
    if (new Date(t.due_at).getTime() < now.getTime()) {
      out.push(t);
    }
  }
  return out.sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''));
}

// ─── My tasks (this week) ─────────────────────────────────────
// Open tasks assigned to the current user whose due_at is in the
// next DUE_SOON_DAYS or is already overdue. Sorted by due date.

export function findMyTasksThisWeek(tasks, email, now = new Date()) {
  const normalized = (email ?? '').trim().toLowerCase();
  if (!normalized) return [];
  const horizon = new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000);
  const out = [];
  for (const t of tasks ?? []) {
    if (!['pending', 'in_progress'].includes(t.status)) continue;
    if ((t.assigned_to ?? '').trim().toLowerCase() !== normalized) continue;
    if (!t.due_at) continue;
    const due = new Date(t.due_at).getTime();
    if (due <= horizon.getTime()) {
      out.push(t);
    }
  }
  return out.sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''));
}

// ─── Top stats row ────────────────────────────────────────────
// One-shot computation the dashboard renders as KPI cards.
// `tasks` may be empty for admin viewers (RLS denies on exec_tasks);
// the helper degrades gracefully.

export function computeKpiStats({ goals, tasks, email, now = new Date() }) {
  const openTasks = (tasks ?? []).filter((t) =>
    ['pending', 'in_progress'].includes(t.status)
  );
  const overdueTasks = findOverdueTasks(tasks ?? [], now);
  const staleKrs = findStaleKrs(goals ?? [], { now });
  const atRiskGoals = findAtRiskGoals(goals ?? []);

  const myThisWeek = findMyTasksThisWeek(tasks ?? [], email, now);

  return {
    open_tasks: openTasks.length,
    overdue_tasks: overdueTasks.length,
    stale_krs: staleKrs.length,
    at_risk_goals: atRiskGoals.length,
    my_this_week: myThisWeek.length,
  };
}
