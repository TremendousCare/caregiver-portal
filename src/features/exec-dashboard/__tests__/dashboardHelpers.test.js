import { describe, it, expect } from 'vitest';
import {
  summarizeGoal,
  findStaleKrs,
  findAtRiskGoals,
  findOverdueTasks,
  findMyTasksThisWeek,
  computeKpiStats,
  STALE_KR_DAYS,
  DUE_SOON_DAYS,
} from '../lib/dashboardHelpers';

const NOW = new Date('2026-05-28T15:00:00Z');
const isoDaysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
const isoDaysAhead = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000).toISOString();

// ─── summarizeGoal ───────────────────────────────────────────

describe('summarizeGoal', () => {
  it('handles empty KR list', () => {
    const s = summarizeGoal({ status: 'active', exec_key_results: [] });
    expect(s).toEqual({
      krCount: 0, achievedCount: 0, avgPct: null,
      worstConfidence: null, atRisk: false,
    });
  });

  it('handles null/undefined goal', () => {
    expect(summarizeGoal(null).krCount).toBe(0);
  });

  it('counts achieved KRs and averages pct', () => {
    const s = summarizeGoal({
      status: 'active',
      exec_key_results: [
        { start_value: 0, current_value: 100, target_value: 100, direction: 'increase', confidence: 'green' }, // achieved
        { start_value: 0, current_value: 50,  target_value: 100, direction: 'increase', confidence: 'green' }, // 0.5
      ],
    });
    expect(s.krCount).toBe(2);
    expect(s.achievedCount).toBe(1);
    expect(s.avgPct).toBe(0.75); // (1.0 + 0.5) / 2
    expect(s.worstConfidence).toBe('green');
    expect(s.atRisk).toBe(false);
  });

  it('clamps individual pct to [0,1] before averaging (stretch ≠ counted >1)', () => {
    const s = summarizeGoal({
      status: 'active',
      exec_key_results: [
        { start_value: 0, current_value: 200, target_value: 100, direction: 'increase', confidence: 'green' },
        { start_value: 0, current_value: 0,   target_value: 100, direction: 'increase', confidence: 'green' },
      ],
    });
    expect(s.avgPct).toBe(0.5); // (1 + 0) / 2, not (2 + 0) / 2
    expect(s.achievedCount).toBe(1);
  });

  it("worstConfidence picks red over yellow over green", () => {
    expect(summarizeGoal({
      status: 'active',
      exec_key_results: [
        { target_value: 100, current_value: 50, confidence: 'green' },
        { target_value: 100, current_value: 50, confidence: 'yellow' },
      ],
    }).worstConfidence).toBe('yellow');

    expect(summarizeGoal({
      status: 'active',
      exec_key_results: [
        { target_value: 100, current_value: 50, confidence: 'yellow' },
        { target_value: 100, current_value: 50, confidence: 'red' },
        { target_value: 100, current_value: 50, confidence: 'green' },
      ],
    }).worstConfidence).toBe('red');
  });

  it('atRisk: active goal with any red KR', () => {
    const s = summarizeGoal({
      status: 'active',
      exec_key_results: [
        { target_value: 100, current_value: 90, confidence: 'green' },
        { target_value: 100, current_value: 10, confidence: 'red' },
      ],
    });
    expect(s.atRisk).toBe(true);
  });

  it('atRisk: active goal with avg pct < 0.4 (even with green confidence)', () => {
    const s = summarizeGoal({
      status: 'active',
      exec_key_results: [
        { start_value: 0, current_value: 20, target_value: 100, direction: 'increase', confidence: 'green' },
      ],
    });
    expect(s.atRisk).toBe(true);
  });

  it('atRisk: never true for non-active goals', () => {
    const s = summarizeGoal({
      status: 'achieved',
      exec_key_results: [
        { target_value: 100, current_value: 0, confidence: 'red' },
      ],
    });
    expect(s.atRisk).toBe(false);
  });
});

// ─── findStaleKrs ────────────────────────────────────────────

describe('findStaleKrs', () => {
  const buildGoal = (krs, status = 'active') => ({
    id: `g-${krs[0]?.id ?? 'x'}`, title: 'G', status, exec_key_results: krs,
  });

  it('returns KRs older than threshold + never-checked-in', () => {
    const goals = [
      buildGoal([
        { id: 'a', title: 'A', owner_email: 'k@x', confidence: 'green', last_checked_in_at: isoDaysAgo(20) }, // stale
        { id: 'b', title: 'B', owner_email: 'k@x', confidence: 'green', last_checked_in_at: isoDaysAgo(5) },  // fresh
        { id: 'c', title: 'C', owner_email: 'k@x', confidence: 'green', last_checked_in_at: null },           // never
      ]),
    ];
    const r = findStaleKrs(goals, { now: NOW });
    expect(r.map((x) => x.kr_id).sort()).toEqual(['a', 'c']);
  });

  it('never-checked-in items sort to the top', () => {
    const goals = [
      buildGoal([
        { id: 'a', title: 'A', last_checked_in_at: isoDaysAgo(30) },
        { id: 'b', title: 'B', last_checked_in_at: null },
        { id: 'c', title: 'C', last_checked_in_at: isoDaysAgo(20) },
      ]),
    ];
    const r = findStaleKrs(goals, { now: NOW });
    expect(r[0].kr_id).toBe('b'); // never
    expect(r[1].kr_id).toBe('a'); // 30 days
    expect(r[2].kr_id).toBe('c'); // 20 days
  });

  it('skips KRs whose goal is not active', () => {
    const goals = [
      buildGoal([{ id: 'a', title: 'A', last_checked_in_at: null }], 'achieved'),
    ];
    expect(findStaleKrs(goals, { now: NOW })).toEqual([]);
  });

  it('respects custom threshold', () => {
    const goals = [
      buildGoal([
        { id: 'a', title: 'A', last_checked_in_at: isoDaysAgo(5) },
      ]),
    ];
    expect(findStaleKrs(goals, { now: NOW, daysThreshold: 3 })).toHaveLength(1);
    expect(findStaleKrs(goals, { now: NOW, daysThreshold: 10 })).toEqual([]);
  });

  it('default threshold is STALE_KR_DAYS', () => {
    expect(STALE_KR_DAYS).toBeGreaterThan(0);
  });
});

// ─── findAtRiskGoals ────────────────────────────────────────

describe('findAtRiskGoals', () => {
  it('returns goal+summary pairs for at-risk goals only', () => {
    const goals = [
      { id: 'g1', title: 'safe', status: 'active', exec_key_results: [
        { target_value: 100, current_value: 90, confidence: 'green' },
      ] },
      { id: 'g2', title: 'risky', status: 'active', exec_key_results: [
        { target_value: 100, current_value: 5, confidence: 'red' },
      ] },
      { id: 'g3', title: 'archived', status: 'achieved', exec_key_results: [
        { target_value: 100, current_value: 5, confidence: 'red' },
      ] },
    ];
    const r = findAtRiskGoals(goals);
    expect(r.map((x) => x.goal.id)).toEqual(['g2']);
    expect(r[0].summary.worstConfidence).toBe('red');
  });

  it('returns empty list when nothing is at risk', () => {
    expect(findAtRiskGoals([
      { id: 'g1', status: 'active', exec_key_results: [
        { target_value: 100, current_value: 90, confidence: 'green' },
      ] },
    ])).toEqual([]);
  });
});

// ─── findOverdueTasks ───────────────────────────────────────

describe('findOverdueTasks', () => {
  it('returns pending/in_progress past due, oldest first', () => {
    const tasks = [
      { id: 'a', status: 'pending',     due_at: isoDaysAgo(5) },
      { id: 'b', status: 'in_progress', due_at: isoDaysAgo(1) },
      { id: 'c', status: 'done',        due_at: isoDaysAgo(10) }, // done, skip
      { id: 'd', status: 'pending',     due_at: isoDaysAhead(1) }, // future, skip
      { id: 'e', status: 'snoozed',     due_at: isoDaysAgo(2) }, // snoozed, skip
    ];
    const r = findOverdueTasks(tasks, NOW);
    expect(r.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('safely handles null/empty tasks', () => {
    expect(findOverdueTasks(null, NOW)).toEqual([]);
    expect(findOverdueTasks([], NOW)).toEqual([]);
  });
});

// ─── findMyTasksThisWeek ────────────────────────────────────

describe('findMyTasksThisWeek', () => {
  const email = 'kevin@tc.com';

  it('returns my open tasks due within the window', () => {
    const tasks = [
      { id: 'a', status: 'pending',     assigned_to: email,         due_at: isoDaysAhead(2) },
      { id: 'b', status: 'pending',     assigned_to: email,         due_at: isoDaysAgo(1) },   // overdue but mine: still in
      { id: 'c', status: 'pending',     assigned_to: email,         due_at: isoDaysAhead(20) }, // outside horizon
      { id: 'd', status: 'pending',     assigned_to: 'someone@else', due_at: isoDaysAhead(1) }, // not mine
      { id: 'e', status: 'done',        assigned_to: email,         due_at: isoDaysAhead(1) }, // done
      { id: 'f', status: 'in_progress', assigned_to: email,         due_at: isoDaysAhead(0) },
    ];
    const r = findMyTasksThisWeek(tasks, email, NOW);
    expect(r.map((t) => t.id).sort()).toEqual(['a', 'b', 'f']);
  });

  it('case-insensitive on assignee email', () => {
    const tasks = [{ id: 'a', status: 'pending', assigned_to: '  KEVIN@TC.COM ', due_at: isoDaysAhead(1) }];
    expect(findMyTasksThisWeek(tasks, 'kevin@tc.com', NOW)).toHaveLength(1);
  });

  it('returns empty when email is missing', () => {
    expect(findMyTasksThisWeek([{ status: 'pending', assigned_to: 'a@b', due_at: isoDaysAhead(1) }], '', NOW)).toEqual([]);
    expect(findMyTasksThisWeek([{ status: 'pending', assigned_to: 'a@b', due_at: isoDaysAhead(1) }], null, NOW)).toEqual([]);
  });

  it('sorted by due_at ascending', () => {
    const tasks = [
      { id: 'late',  status: 'pending', assigned_to: email, due_at: isoDaysAhead(5) },
      { id: 'early', status: 'pending', assigned_to: email, due_at: isoDaysAhead(1) },
      { id: 'mid',   status: 'pending', assigned_to: email, due_at: isoDaysAhead(3) },
    ];
    const r = findMyTasksThisWeek(tasks, email, NOW);
    expect(r.map((t) => t.id)).toEqual(['early', 'mid', 'late']);
  });

  it('default horizon is DUE_SOON_DAYS', () => {
    expect(DUE_SOON_DAYS).toBeGreaterThan(0);
  });
});

// ─── computeKpiStats ─────────────────────────────────────────

describe('computeKpiStats', () => {
  it('rolls up all four counters', () => {
    const goals = [
      { id: 'g1', status: 'active', exec_key_results: [
        { id: 'k1', target_value: 100, current_value: 5, confidence: 'red', last_checked_in_at: isoDaysAgo(20) },
      ] },
    ];
    const tasks = [
      { id: 't1', status: 'pending', assigned_to: 'kevin@tc.com', due_at: isoDaysAgo(1) },
      { id: 't2', status: 'pending', assigned_to: 'kevin@tc.com', due_at: isoDaysAhead(2) },
      { id: 't3', status: 'pending', assigned_to: 'someone@else', due_at: isoDaysAhead(1) },
      { id: 't4', status: 'done',    assigned_to: 'kevin@tc.com', due_at: isoDaysAgo(2) },
    ];
    const r = computeKpiStats({ goals, tasks, email: 'kevin@tc.com', now: NOW });
    expect(r).toEqual({
      open_tasks: 3,      // t1, t2, t3 are open
      overdue_tasks: 1,   // t1
      stale_krs: 1,       // k1 (20 days old)
      at_risk_goals: 1,   // g1 has a red KR
      my_this_week: 2,    // t1 (overdue, mine) + t2 (in horizon, mine)
    });
  });

  it('degrades gracefully when tasks is empty (admin viewer)', () => {
    const goals = [
      { id: 'g1', status: 'active', exec_key_results: [
        { target_value: 100, current_value: 90, confidence: 'green', last_checked_in_at: isoDaysAgo(2) },
      ] },
    ];
    const r = computeKpiStats({ goals, tasks: [], email: 'admin@tc.com', now: NOW });
    expect(r.open_tasks).toBe(0);
    expect(r.overdue_tasks).toBe(0);
    expect(r.my_this_week).toBe(0);
    expect(r.stale_krs).toBe(0);
    expect(r.at_risk_goals).toBe(0);
  });

  it('handles missing goals + tasks safely', () => {
    const r = computeKpiStats({ goals: null, tasks: null, email: 'x@x', now: NOW });
    expect(r).toEqual({
      open_tasks: 0,
      overdue_tasks: 0,
      stale_krs: 0,
      at_risk_goals: 0,
      my_this_week: 0,
    });
  });
});
