import { describe, it, expect } from 'vitest';
import {
  PERIODS,
  PERIOD_LABELS,
  toIsoDate,
  todayIso,
  addDaysIso,
  isGoalActive,
  findActiveGoal,
  validateGoalDraft,
  progressVsTarget,
  fetchBdGoals,
  saveGoal,
} from '../../features/bd-goals/lib/goalsQueries';

describe('exported constants', () => {
  it('PERIODS matches the bd_goals.period CHECK domain', () => {
    expect(PERIODS).toEqual(['weekly', 'monthly']);
  });
  it('PERIOD_LABELS covers every period', () => {
    for (const p of PERIODS) expect(PERIOD_LABELS[p]).toBeTruthy();
  });
});

// ─── Date helpers ─────────────────────────────────────────────

describe('toIsoDate', () => {
  it('passes through valid YYYY-MM-DD strings', () => {
    expect(toIsoDate('2026-05-09')).toBe('2026-05-09');
  });
  it('truncates a longer ISO string to date-only', () => {
    expect(toIsoDate('2026-05-09T15:30:00Z')).toBe('2026-05-09');
  });
  it('formats Date objects in local components', () => {
    expect(toIsoDate(new Date(2026, 4, 9))).toBe('2026-05-09');
  });
  it('returns null for bad input', () => {
    expect(toIsoDate(null)).toBe(null);
    expect(toIsoDate('')).toBe(null);
    expect(toIsoDate('garbage')).toBe(null);
  });
});

describe('addDaysIso', () => {
  it('adds and subtracts whole days', () => {
    expect(addDaysIso('2026-05-09', 1)).toBe('2026-05-10');
    expect(addDaysIso('2026-05-01', -1)).toBe('2026-04-30');
  });
  it('crosses month + year boundaries', () => {
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('returns null for null input', () => {
    expect(addDaysIso(null, 1)).toBe(null);
  });
});

// ─── Active goal selection ───────────────────────────────────

describe('isGoalActive', () => {
  const today = '2026-05-09';
  it('rejects a goal that starts in the future', () => {
    expect(isGoalActive({ effective_from: '2026-05-10', effective_to: null }, today)).toBe(false);
  });
  it('accepts an open-ended goal that started in the past', () => {
    expect(isGoalActive({ effective_from: '2026-05-01', effective_to: null }, today)).toBe(true);
  });
  it('accepts a closed goal whose end is still in the future', () => {
    expect(isGoalActive({ effective_from: '2026-05-01', effective_to: '2026-05-31' }, today)).toBe(true);
  });
  it('rejects a closed goal that ended yesterday', () => {
    expect(isGoalActive({ effective_from: '2026-05-01', effective_to: '2026-05-08' }, today)).toBe(false);
  });
  it('returns false for null goal', () => {
    expect(isGoalActive(null, today)).toBe(false);
  });
});

describe('findActiveGoal', () => {
  const today = '2026-05-09';
  const goals = [
    { id: 'A', period: 'weekly',  assignee_email: 'sasha@tc.com',  effective_from: '2026-05-01', effective_to: null,         visits_target: 35 },
    { id: 'B', period: 'weekly',  assignee_email: 'sasha@tc.com',  effective_from: '2026-04-01', effective_to: '2026-04-30', visits_target: 30 },
    { id: 'C', period: 'monthly', assignee_email: 'sasha@tc.com',  effective_from: '2026-05-01', effective_to: null,         visits_target: 140 },
    { id: 'D', period: 'weekly',  assignee_email: 'other@tc.com',  effective_from: '2026-05-01', effective_to: null,         visits_target: 20 },
  ];

  it('matches by period + assignee', () => {
    const g = findActiveGoal(goals, { period: 'weekly', assigneeEmail: 'sasha@tc.com' }, today);
    expect(g?.id).toBe('A');
  });

  it('returns null when no row matches', () => {
    const g = findActiveGoal(goals, { period: 'weekly', assigneeEmail: 'unknown@tc.com' }, today);
    expect(g).toBe(null);
  });

  it('handles null/undefined goal lists', () => {
    expect(findActiveGoal(null,      { period: 'weekly', assigneeEmail: 'x' })).toBe(null);
    expect(findActiveGoal(undefined, { period: 'weekly', assigneeEmail: 'x' })).toBe(null);
  });
});

// ─── Validation ──────────────────────────────────────────────

const validDraft = () => ({
  assignee_email:   'sasha@tc.com',
  period:           'weekly',
  visits_target:    35,
  referrals_target: 4,
  soc_target:       2,
  effective_from:   '2026-05-09',
});

describe('validateGoalDraft', () => {
  it('accepts a valid draft', () => {
    expect(validateGoalDraft(validDraft())).toEqual({ ok: true });
  });
  it('rejects a missing or invalid email', () => {
    expect(validateGoalDraft({ ...validDraft(), assignee_email: '' }).ok).toBe(false);
    expect(validateGoalDraft({ ...validDraft(), assignee_email: 'not-an-email' }).ok).toBe(false);
  });
  it('rejects an unknown period', () => {
    expect(validateGoalDraft({ ...validDraft(), period: 'daily' }).ok).toBe(false);
  });
  it('rejects negative or non-integer targets', () => {
    expect(validateGoalDraft({ ...validDraft(), visits_target: -1 }).ok).toBe(false);
    expect(validateGoalDraft({ ...validDraft(), visits_target: 1.5 }).ok).toBe(false);
  });
  it('requires at least one target', () => {
    expect(validateGoalDraft({
      ...validDraft(),
      visits_target: null, referrals_target: null, soc_target: null,
    }).ok).toBe(false);
  });
  it('requires effective_from', () => {
    expect(validateGoalDraft({ ...validDraft(), effective_from: '' }).ok).toBe(false);
  });
});

// ─── Progress overlay ────────────────────────────────────────

describe('progressVsTarget', () => {
  it('returns null pct when target is null/zero', () => {
    expect(progressVsTarget(5, null)).toEqual({ actual: 5, target: null, pct: null, on_track: null, label: null });
    expect(progressVsTarget(5, 0)).toEqual({ actual: 5, target: null, pct: null, on_track: null, label: null });
  });
  it('labels progress as goal/track/behind/early', () => {
    expect(progressVsTarget(10, 10).label).toBe('goal reached');
    expect(progressVsTarget(8, 10).label).toBe('on track');
    expect(progressVsTarget(5, 10).label).toBe('behind');
    expect(progressVsTarget(2, 10).label).toBe('early');
  });
  it('flags on_track at 70%+', () => {
    expect(progressVsTarget(7, 10).on_track).toBe(true);
    expect(progressVsTarget(6, 10).on_track).toBe(false);
  });
});

// ─── Supabase wrappers ──────────────────────────────────────

function chainable(result) {
  const c = {
    select() { return c; },
    eq()     { return c; },
    order()  { return Promise.resolve(result); },
    single:  () => Promise.resolve(result),
    then(resolve) { return Promise.resolve(result).then(resolve); },
  };
  return c;
}

function makeStub({ goalsList = [], insertResult = null, updateOk = true, observed = [] } = {}) {
  const stub = {
    _observed: observed,
    from(table) {
      if (table !== 'bd_goals') throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return {
            order: () => Promise.resolve({ data: goalsList, error: null }),
          };
        },
        insert(row) {
          observed.push({ op: 'insert', row });
          return {
            select() { return this; },
            single: () => Promise.resolve(insertResult ?? {
              data: { id: 'new', ...row, effective_from: row.effective_from },
              error: null,
            }),
          };
        },
        update(patch) {
          observed.push({ op: 'update', patch });
          return {
            eq: () => Promise.resolve(updateOk ? { error: null } : { error: new Error('upd-fail') }),
          };
        },
      };
    },
  };
  return stub;
}

describe('fetchBdGoals', () => {
  it('returns empty + null error when supabase missing', async () => {
    expect(await fetchBdGoals(null)).toEqual({ data: [], error: null });
  });
  it('returns rows from the order() chain', async () => {
    const stub = makeStub({ goalsList: [{ id: 'A' }, { id: 'B' }] });
    const r = await fetchBdGoals(stub);
    expect(r.error).toBe(null);
    expect(r.data.length).toBe(2);
  });
});

describe('saveGoal', () => {
  it('rejects without supabase', async () => {
    const r = await saveGoal(null, { orgId: 'o', draft: validDraft(), createdBy: 'u', existingGoals: [] });
    expect(r.error).toBeTruthy();
  });

  it('rejects when validation fails', async () => {
    const stub = makeStub();
    const r = await saveGoal(stub, { orgId: 'o', draft: { ...validDraft(), period: 'daily' }, createdBy: 'u', existingGoals: [] });
    expect(r.error).toBeTruthy();
    expect(stub._observed).toHaveLength(0);
  });

  it('rejects without org_id', async () => {
    const stub = makeStub();
    const r = await saveGoal(stub, { orgId: null, draft: validDraft(), createdBy: 'u', existingGoals: [] });
    expect(r.error?.message).toMatch(/org/i);
    expect(stub._observed).toHaveLength(0);
  });

  it('inserts the new goal and closes out a prior overlapping active goal', async () => {
    const observed = [];
    const stub = makeStub({
      observed,
      insertResult: { data: { id: 'new-1', assignee_email: 'sasha@tc.com', period: 'weekly', effective_from: '2026-05-09' }, error: null },
    });
    const existing = [
      { id: 'old', assignee_email: 'sasha@tc.com', period: 'weekly', effective_from: '2026-04-01', effective_to: null },
    ];
    const r = await saveGoal(stub, { orgId: 'org-1', draft: validDraft(), createdBy: 'Sasha', existingGoals: existing });
    expect(r.error).toBe(null);
    const ops = observed.map((o) => o.op);
    expect(ops).toEqual(['insert', 'update']);
    const update = observed.find((o) => o.op === 'update');
    expect(update.patch.effective_to).toBe('2026-05-08');
  });

  it('does NOT close a prior goal for a different period or assignee', async () => {
    const observed = [];
    const stub = makeStub({
      observed,
      insertResult: { data: { id: 'new-1', assignee_email: 'sasha@tc.com', period: 'weekly', effective_from: '2026-05-09' }, error: null },
    });
    const existing = [
      { id: 'monthly-row',  assignee_email: 'sasha@tc.com', period: 'monthly', effective_from: '2026-04-01', effective_to: null },
      { id: 'other-rep',     assignee_email: 'other@tc.com',  period: 'weekly',  effective_from: '2026-04-01', effective_to: null },
    ];
    await saveGoal(stub, { orgId: 'org-1', draft: validDraft(), createdBy: 'Sasha', existingGoals: existing });
    const ops = observed.map((o) => o.op);
    expect(ops).toEqual(['insert']);
  });

  it('lower-cases the assignee email before inserting', async () => {
    const observed = [];
    const stub = makeStub({ observed });
    await saveGoal(stub, {
      orgId: 'o',
      draft: { ...validDraft(), assignee_email: '  Sasha@TC.com ' },
      createdBy: 'admin',
      existingGoals: [],
    });
    const insertOp = observed.find((o) => o.op === 'insert');
    expect(insertOp.row.assignee_email).toBe('sasha@tc.com');
  });
});
