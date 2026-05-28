import { describe, it, expect } from 'vitest';
import {
  fetchTasks,
  createAdHocTask,
  completeTask,
  snoozeTask,
  cancelTask,
  reopenTask,
  validateAdHocDraft,
  validateStructuredResponses,
} from '../lib/tasksQueries';

function makeSupabaseMock(opts = {}) {
  const calls = [];
  function builder(tableName) {
    const state = {
      table: tableName,
      filters: [],
      orderArgs: [],
      inArgs: null,
      selectCols: null,
      insertRow: null,
      updateRow: null,
      limitVal: null,
      single: false,
    };
    const chain = {
      select(cols) { state.selectCols = cols; return chain; },
      insert(row)  { state.insertRow = row; return chain; },
      update(row)  { state.updateRow = row; return chain; },
      eq(col, val) { state.filters.push(['eq', col, val]); return chain; },
      in(col, vals) { state.inArgs = [col, vals]; return chain; },
      order(col, o) { state.orderArgs.push([col, o]); return chain; },
      limit(n)     { state.limitVal = n; return chain; },
      single()     { state.single = true; return chain; },
      then(resolve, reject) {
        calls.push(state);
        const result = opts.responder ? opts.responder(state) : { data: null, error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }
  return { from: builder, _calls: calls };
}

// ─── validateAdHocDraft ──────────────────────────────────────

describe('validateAdHocDraft', () => {
  it('accepts a minimal valid draft', () => {
    expect(validateAdHocDraft({ title: 'x', due_at: '2026-06-01T09:00:00Z' }).ok).toBe(true);
  });
  it('rejects empty title', () => {
    expect(validateAdHocDraft({ title: '   ', due_at: '2026-06-01T09:00:00Z' }).ok).toBe(false);
  });
  it('rejects missing due_at', () => {
    expect(validateAdHocDraft({ title: 'x' }).ok).toBe(false);
  });
});

// ─── validateStructuredResponses ──────────────────────────────

describe('validateStructuredResponses', () => {
  it('passes when there are no questions', () => {
    expect(validateStructuredResponses(null, {}).ok).toBe(true);
    expect(validateStructuredResponses([], {}).ok).toBe(true);
  });
  it('passes when all required questions have responses', () => {
    const qs = [
      { id: 'a', label: 'Foo', required: true },
      { id: 'b', label: 'Bar', required: false },
    ];
    expect(validateStructuredResponses(qs, { a: 'yes' }).ok).toBe(true);
  });
  it('fails when a required question is missing', () => {
    const qs = [{ id: 'a', label: 'Foo', required: true }];
    expect(validateStructuredResponses(qs, {}).ok).toBe(false);
    expect(validateStructuredResponses(qs, { a: '' }).ok).toBe(false);
    expect(validateStructuredResponses(qs, { a: null }).ok).toBe(false);
  });
  it('fails when a required array response is empty', () => {
    const qs = [{ id: 'a', label: 'Foo', required: true }];
    expect(validateStructuredResponses(qs, { a: [] }).ok).toBe(false);
  });
  it('non-required questions never block', () => {
    const qs = [{ id: 'a', label: 'Foo' }];
    expect(validateStructuredResponses(qs, {}).ok).toBe(true);
  });
  it('error message names the missing question', () => {
    const qs = [{ id: 'a', label: 'Decision' }];
    qs[0].required = true;
    expect(validateStructuredResponses(qs, {}).error).toMatch(/Decision/);
  });
});

// ─── fetchTasks ──────────────────────────────────────────────

describe('fetchTasks', () => {
  it('default sort: due_at ascending, limit 100', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: [], error: null }) });
    await fetchTasks(sb);
    expect(sb._calls[0].table).toBe('exec_tasks');
    expect(sb._calls[0].orderArgs).toEqual([['due_at', { ascending: true }]]);
    expect(sb._calls[0].limitVal).toBe(100);
  });
  it('"open" filter becomes IN (pending, in_progress, snoozed)', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: [], error: null }) });
    await fetchTasks(sb, { status: 'open' });
    expect(sb._calls[0].inArgs).toEqual(['status', ['pending', 'in_progress', 'snoozed']]);
  });
  it('specific status filter uses eq', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: [], error: null }) });
    await fetchTasks(sb, { status: 'done' });
    expect(sb._calls[0].filters).toEqual([['eq', 'status', 'done']]);
  });
  it('"all" status applies no status filter', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: [], error: null }) });
    await fetchTasks(sb, { status: 'all' });
    expect(sb._calls[0].filters).toEqual([]);
    expect(sb._calls[0].inArgs).toBe(null);
  });
  it('select includes nested template structured_questions', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: [], error: null }) });
    await fetchTasks(sb);
    expect(sb._calls[0].selectCols).toMatch(/exec_task_templates[\s\S]*?structured_questions/);
  });
});

// ─── createAdHocTask ─────────────────────────────────────────

describe('createAdHocTask', () => {
  const validDraft = {
    title: 'Audit vendor invoices',
    description: 'desc',
    assigned_to: ' KEVIN@TC.COM ',
    due_at: '2026-06-01T09:00:00Z',
    urgency: 'critical',
  };

  it('rejects without orgId', async () => {
    const sb = makeSupabaseMock();
    const r = await createAdHocTask(sb, { orgId: null, draft: validDraft });
    expect(r.error.message).toMatch(/Missing org_id/);
  });

  it('rejects an invalid draft', async () => {
    const sb = makeSupabaseMock();
    const r = await createAdHocTask(sb, { orgId: 'org-1', draft: { title: '' } });
    expect(r.error.message).toMatch(/Title/);
  });

  it('inserts category=ad_hoc with normalized fields', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: { id: 'new', ...state.insertRow }, error: null }),
    });
    const r = await createAdHocTask(sb, { orgId: 'org-1', draft: validDraft });
    expect(r.error).toBe(null);
    const row = sb._calls[0].insertRow;
    expect(row.category).toBe('ad_hoc');
    expect(row.template_id).toBe(null);
    expect(row.assigned_to).toBe('kevin@tc.com'); // lowered + trimmed
    expect(row.org_id).toBe('org-1');
    expect(row.title).toBe('Audit vendor invoices');
    expect(row.urgency).toBe('critical');
  });

  it('defaults urgency to warning when omitted', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.insertRow, error: null }),
    });
    const { urgency, ...rest } = validDraft;
    await createAdHocTask(sb, { orgId: 'org-1', draft: rest });
    expect(sb._calls[0].insertRow.urgency).toBe('warning');
    expect(urgency).toBeDefined();
  });
});

// ─── completeTask ────────────────────────────────────────────

describe('completeTask', () => {
  it('updates status=done with timestamp, completed_by, responses, outcome', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await completeTask(sb, {
      id: 't1',
      completedBy: 'kevin@tc.com',
      structuredResponses: { q1: 4 },
      completionNotes: ' note ',
      outcome: 'on_track',
      questions: [],
    });
    const u = sb._calls[0].updateRow;
    expect(u.status).toBe('done');
    expect(u.completed_by).toBe('kevin@tc.com');
    expect(u.structured_responses).toEqual({ q1: 4 });
    expect(u.outcome).toBe('on_track');
    expect(u.completion_notes).toBe('note'); // trimmed
    expect(u.completed_at).toBeTruthy();
  });

  it('rejects missing required question', async () => {
    const sb = makeSupabaseMock();
    const r = await completeTask(sb, {
      id: 't1',
      structuredResponses: {},
      questions: [{ id: 'a', label: 'Foo', required: true }],
    });
    expect(r.error.message).toMatch(/Foo/);
    expect(sb._calls.length).toBe(0);
  });

  it('rejects invalid outcome', async () => {
    const sb = makeSupabaseMock();
    const r = await completeTask(sb, {
      id: 't1',
      structuredResponses: {},
      outcome: 'maybe',
      questions: [],
    });
    expect(r.error.message).toMatch(/Invalid outcome/);
  });

  it('accepts null/undefined outcome', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    const r = await completeTask(sb, { id: 't1', structuredResponses: {}, questions: [] });
    expect(r.error).toBe(null);
    expect(sb._calls[0].updateRow.outcome).toBe(null);
  });
});

// ─── snoozeTask ──────────────────────────────────────────────

describe('snoozeTask', () => {
  it('writes status=snoozed + snoozed_until', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await snoozeTask(sb, { id: 't1', snoozedUntil: '2026-06-15T09:00:00Z' });
    expect(sb._calls[0].updateRow).toEqual({
      status: 'snoozed',
      snoozed_until: '2026-06-15T09:00:00Z',
    });
    expect(sb._calls[0].filters).toEqual([['eq', 'id', 't1']]);
  });
  it('rejects without snoozedUntil', async () => {
    const sb = makeSupabaseMock();
    const r = await snoozeTask(sb, { id: 't1', snoozedUntil: null });
    expect(r.error.message).toMatch(/Snooze date required/);
  });
});

// ─── cancelTask ──────────────────────────────────────────────

describe('cancelTask', () => {
  it('writes status=cancelled + reason (trimmed)', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await cancelTask(sb, { id: 't1', reason: '  no longer needed  ' });
    expect(sb._calls[0].updateRow.status).toBe('cancelled');
    expect(sb._calls[0].updateRow.cancellation_reason).toBe('no longer needed');
  });
  it('reason is optional', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await cancelTask(sb, { id: 't1' });
    expect(sb._calls[0].updateRow.cancellation_reason).toBe(null);
  });
});

// ─── reopenTask ──────────────────────────────────────────────

describe('reopenTask', () => {
  it('clears completion fields and resets status to pending', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await reopenTask(sb, { id: 't1' });
    expect(sb._calls[0].updateRow).toEqual({
      status: 'pending',
      completed_at: null,
      completed_by: null,
      completion_notes: null,
      outcome: null,
    });
  });
});
