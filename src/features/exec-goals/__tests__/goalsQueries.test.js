// Queries tests use a hand-rolled Supabase mock so the assertions
// stay focused on argument shape, validation gating, and the
// post-checkin KR bump side effect. The real Supabase client is not
// invoked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchGoalsForQuarter,
  fetchKnownQuarters,
  createGoal,
  updateGoal,
  deleteGoal,
  createKr,
  updateKr,
  deleteKr,
  upsertCheckin,
} from '../lib/goalsQueries';

// ─── Mock builder ─────────────────────────────────────────────
// Chainable: .from(t).select(c).eq(c, v).order(c, o) etc. The final
// thenable resolves with { data, error }. For .single() it resolves
// to the single-row form.

function makeSupabaseMock(opts = {}) {
  const calls = [];
  function builder(tableName) {
    const state = {
      table: tableName,
      filters: [],
      orderArgs: null,
      selectCols: null,
      insertRow: null,
      updateRow: null,
      upsertRow: null,
      upsertOpts: null,
      deleted: false,
      single: false,
    };
    const chain = {
      select(cols) { state.selectCols = cols; return chain; },
      insert(row)  { state.insertRow = row; return chain; },
      update(row)  { state.updateRow = row; return chain; },
      upsert(row, options) { state.upsertRow = row; state.upsertOpts = options; return chain; },
      delete()     { state.deleted = true; return chain; },
      eq(col, val) { state.filters.push(['eq', col, val]); return chain; },
      order(col, o) { state.orderArgs = [col, o]; return chain; },
      single()     { state.single = true; return chain; },
      then(resolve, reject) {
        calls.push(state);
        const result = opts.responder ? opts.responder(state) : { data: null, error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }
  return {
    from: builder,
    _calls: calls,
  };
}

// ─── fetch ────────────────────────────────────────────────────

describe('fetchGoalsForQuarter', () => {
  it('queries exec_goals filtered by quarter, ordered by sort_order', async () => {
    const sb = makeSupabaseMock({
      responder: () => ({ data: [{ id: 'g1', quarter: '2026-Q2' }], error: null }),
    });
    const r = await fetchGoalsForQuarter(sb, '2026-Q2');
    expect(r.error).toBe(null);
    expect(r.data).toHaveLength(1);
    expect(sb._calls[0].table).toBe('exec_goals');
    expect(sb._calls[0].filters).toEqual([['eq', 'quarter', '2026-Q2']]);
    expect(sb._calls[0].orderArgs).toEqual(['sort_order', { ascending: true }]);
  });

  it('select includes nested KRs and check-ins', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: [], error: null }) });
    await fetchGoalsForQuarter(sb, '2026-Q2');
    expect(sb._calls[0].selectCols).toMatch(/exec_key_results/);
    expect(sb._calls[0].selectCols).toMatch(/exec_goal_checkins/);
  });

  it('returns empty data when supabase is null', async () => {
    const r = await fetchGoalsForQuarter(null, '2026-Q2');
    expect(r.data).toEqual([]);
    expect(r.error).toBe(null);
  });

  it('returns empty data when quarter is falsy (no DB hit)', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: [{ id: 'x' }], error: null }) });
    const r = await fetchGoalsForQuarter(sb, '');
    expect(r.data).toEqual([]);
    expect(sb._calls.length).toBe(0);
  });

  it('propagates errors', async () => {
    const sb = makeSupabaseMock({
      responder: () => ({ data: null, error: { message: 'rls denied' } }),
    });
    const r = await fetchGoalsForQuarter(sb, '2026-Q2');
    expect(r.data).toEqual([]);
    expect(r.error?.message).toBe('rls denied');
  });
});

describe('fetchKnownQuarters', () => {
  it('dedupes quarter values from rows', async () => {
    const sb = makeSupabaseMock({
      responder: () => ({
        data: [{ quarter: '2026-Q1' }, { quarter: '2026-Q1' }, { quarter: '2025-Q4' }],
        error: null,
      }),
    });
    const r = await fetchKnownQuarters(sb);
    expect(r.data.sort()).toEqual(['2025-Q4', '2026-Q1']);
  });
  it('skips falsy/null quarters', async () => {
    const sb = makeSupabaseMock({
      responder: () => ({ data: [{ quarter: '' }, { quarter: null }, { quarter: '2026-Q1' }], error: null }),
    });
    const r = await fetchKnownQuarters(sb);
    expect(r.data).toEqual(['2026-Q1']);
  });
});

// ─── createGoal ───────────────────────────────────────────────

describe('createGoal', () => {
  const validDraft = {
    title: 'Hit 4.8★',
    description: 'desc',
    owner_email: ' KEVIN@TC.COM ',
    quarter: '2026-Q2',
    start_date: '2026-04-01',
    end_date: '2026-06-30',
    status: 'active',
  };

  it('rejects when orgId missing', async () => {
    const sb = makeSupabaseMock();
    const r = await createGoal(sb, { orgId: null, draft: validDraft });
    expect(r.error.message).toMatch(/Missing org_id/);
    expect(sb._calls.length).toBe(0);
  });

  it('rejects when draft fails validation', async () => {
    const sb = makeSupabaseMock();
    const r = await createGoal(sb, {
      orgId: 'org-1',
      draft: { ...validDraft, title: '' },
    });
    expect(r.error.message).toMatch(/Title|title/);
    expect(sb._calls.length).toBe(0);
  });

  it('inserts a normalized row (lowercased email, trimmed strings)', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: { id: 'new', ...state.insertRow }, error: null }),
    });
    const r = await createGoal(sb, { orgId: 'org-1', draft: validDraft });
    expect(r.error).toBe(null);
    expect(sb._calls[0].table).toBe('exec_goals');
    expect(sb._calls[0].insertRow.org_id).toBe('org-1');
    expect(sb._calls[0].insertRow.owner_email).toBe('kevin@tc.com'); // lowered + trimmed
    expect(sb._calls[0].insertRow.title).toBe('Hit 4.8★');
    expect(sb._calls[0].insertRow.status).toBe('active');
  });

  it('defaults status to draft when omitted', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.insertRow, error: null }),
    });
    const { status, ...rest } = validDraft;
    await createGoal(sb, { orgId: 'org-1', draft: rest });
    expect(sb._calls[0].insertRow.status).toBe('draft');
    expect(status).toBeDefined(); // appease unused-var
  });
});

// ─── updateGoal ───────────────────────────────────────────────

describe('updateGoal', () => {
  it('only forwards allowed columns', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await updateGoal(sb, {
      id: 'g1',
      patch: {
        title: 'New',
        owner_email: 'KEVIN@TC.COM',
        org_id: 'attempt-to-change',
        id: 'attempt-to-change',
        bogus_column: 1,
      },
    });
    const u = sb._calls[0].updateRow;
    expect(u.title).toBe('New');
    expect(u.owner_email).toBe('kevin@tc.com');
    expect(u.org_id).toBeUndefined();
    expect(u.id).toBeUndefined();
    expect(u.bogus_column).toBeUndefined();
  });

  it('rejects blank title', async () => {
    const sb = makeSupabaseMock();
    const r = await updateGoal(sb, { id: 'g1', patch: { title: '   ' } });
    expect(r.error.message).toMatch(/blank/i);
    expect(sb._calls.length).toBe(0);
  });

  it('rejects empty patch', async () => {
    const sb = makeSupabaseMock();
    const r = await updateGoal(sb, { id: 'g1', patch: {} });
    expect(r.error.message).toMatch(/No fields/i);
  });

  it('rejects missing id', async () => {
    const sb = makeSupabaseMock();
    const r = await updateGoal(sb, { id: null, patch: { title: 'x' } });
    expect(r.error.message).toMatch(/Missing goal id/);
  });
});

// ─── deleteGoal ───────────────────────────────────────────────

describe('deleteGoal', () => {
  it('runs delete + eq filter', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: null, error: null }) });
    const r = await deleteGoal(sb, 'g1');
    expect(r.error).toBe(null);
    expect(sb._calls[0].deleted).toBe(true);
    expect(sb._calls[0].filters).toEqual([['eq', 'id', 'g1']]);
  });
  it('rejects missing id', async () => {
    const sb = makeSupabaseMock();
    const r = await deleteGoal(sb, null);
    expect(r.error.message).toMatch(/Missing goal id/);
  });
});

// ─── createKr ─────────────────────────────────────────────────

describe('createKr', () => {
  const validDraft = {
    goal_id: 'g1',
    title: 'Hit 4.8',
    owner_email: 'kevin@tc.com',
    metric_unit: 'rating',
    direction: 'increase',
    target_value: 4.8,
    start_value: 4.2,
  };
  it('inserts the validated row', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: { id: 'kr1', ...state.insertRow }, error: null }),
    });
    const r = await createKr(sb, { orgId: 'org-1', draft: validDraft });
    expect(r.error).toBe(null);
    expect(sb._calls[0].table).toBe('exec_key_results');
    expect(sb._calls[0].insertRow.goal_id).toBe('g1');
    expect(sb._calls[0].insertRow.target_value).toBe(4.8);
    expect(sb._calls[0].insertRow.org_id).toBe('org-1');
  });
  it('current_value defaults to start_value when omitted', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.insertRow, error: null }),
    });
    await createKr(sb, { orgId: 'org-1', draft: validDraft });
    expect(sb._calls[0].insertRow.current_value).toBe(4.2);
  });
  it('rejects invalid draft', async () => {
    const sb = makeSupabaseMock();
    const r = await createKr(sb, { orgId: 'org-1', draft: { ...validDraft, target_value: 'foo' } });
    expect(r.error.message).toMatch(/number/i);
    expect(sb._calls.length).toBe(0);
  });
});

// ─── updateKr ─────────────────────────────────────────────────

describe('updateKr', () => {
  it('only forwards allowed columns', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await updateKr(sb, {
      id: 'k1',
      patch: {
        title: 'New', goal_id: 'cant-change', org_id: 'cant-change',
        current_value: '50', last_checked_in_at: '2026-05-28T12:00:00Z',
      },
    });
    const u = sb._calls[0].updateRow;
    expect(u.title).toBe('New');
    expect(u.current_value).toBe(50); // coerced to number
    expect(u.last_checked_in_at).toBe('2026-05-28T12:00:00Z');
    expect(u.goal_id).toBeUndefined();
    expect(u.org_id).toBeUndefined();
  });
  it('rejects non-numeric value updates', async () => {
    const sb = makeSupabaseMock();
    const r = await updateKr(sb, { id: 'k1', patch: { current_value: 'high' } });
    expect(r.error.message).toMatch(/number/i);
  });
});

// ─── deleteKr ─────────────────────────────────────────────────

describe('deleteKr', () => {
  it('deletes by id', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: null, error: null }) });
    const r = await deleteKr(sb, 'k1');
    expect(r.error).toBe(null);
    expect(sb._calls[0].deleted).toBe(true);
    expect(sb._calls[0].filters).toEqual([['eq', 'id', 'k1']]);
  });
});

// ─── upsertCheckin ────────────────────────────────────────────

describe('upsertCheckin', () => {
  const validDraft = {
    key_result_id: 'kr1',
    week_of: '2026-05-25',
    value: '4.5',
    confidence: 'green',
    author: 'kevin@tc.com',
    note: '  some note  ',
  };

  it('upserts on (key_result_id, week_of) conflict', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => {
        if (state.table === 'exec_goal_checkins') {
          return { data: { id: 'c1', ...state.upsertRow }, error: null };
        }
        return { data: null, error: null };
      },
    });
    const r = await upsertCheckin(sb, { orgId: 'org-1', draft: validDraft });
    expect(r.error).toBe(null);
    const checkinCall = sb._calls.find((c) => c.table === 'exec_goal_checkins');
    expect(checkinCall.upsertOpts).toEqual({ onConflict: 'key_result_id,week_of' });
    expect(checkinCall.upsertRow.value).toBe(4.5); // coerced
    expect(checkinCall.upsertRow.note).toBe('some note'); // trimmed
    expect(checkinCall.upsertRow.org_id).toBe('org-1');
  });

  it('normalizes week_of to Monday when given a non-Monday', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.upsertRow ?? null, error: null }),
    });
    // 2026-05-27 is a Wednesday; Monday of that week is 2026-05-25
    await upsertCheckin(sb, {
      orgId: 'org-1',
      draft: { ...validDraft, week_of: new Date(2026, 4, 27).toISOString() },
    });
    const checkinCall = sb._calls.find((c) => c.table === 'exec_goal_checkins');
    expect(checkinCall.upsertRow.week_of).toBe('2026-05-25');
  });

  it('bumps the parent KR (current_value + confidence + last_checked_in_at)', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.upsertRow ?? state.updateRow ?? null, error: null }),
    });
    await upsertCheckin(sb, { orgId: 'org-1', draft: validDraft });
    const krBump = sb._calls.find((c) => c.table === 'exec_key_results');
    expect(krBump).toBeDefined();
    expect(krBump.updateRow.current_value).toBe(4.5);
    expect(krBump.updateRow.confidence).toBe('green');
    expect(krBump.updateRow.last_checked_in_at).toBeTruthy();
    expect(krBump.filters).toEqual([['eq', 'id', 'kr1']]);
  });

  it('rejects when validation fails (e.g. missing confidence)', async () => {
    const sb = makeSupabaseMock();
    const r = await upsertCheckin(sb, {
      orgId: 'org-1',
      draft: { ...validDraft, confidence: 'purple' },
    });
    expect(r.error.message).toMatch(/confidence/i);
    expect(sb._calls.length).toBe(0);
  });

  it('rejects without orgId', async () => {
    const sb = makeSupabaseMock();
    const r = await upsertCheckin(sb, { orgId: null, draft: validDraft });
    expect(r.error.message).toMatch(/Missing org_id/);
  });

  it('still returns success when KR bump fails (warning only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sb = makeSupabaseMock({
      responder: (state) => {
        if (state.table === 'exec_key_results') {
          throw new Error('bump failed');
        }
        return { data: state.upsertRow, error: null };
      },
    });
    const r = await upsertCheckin(sb, { orgId: 'org-1', draft: validDraft });
    expect(r.error).toBe(null);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

beforeEach(() => {
  // Each test should start with a clean console.
});
