// Behavioral tests for the follow-up tools registered in
// supabase/functions/ai-chat/tools/tasks.ts (Phase 3 of user-created
// follow-ups). Mocks the registry so we can capture the
// registerTool() calls and exercise the handlers in isolation.

import { describe, it, expect, vi, beforeAll } from 'vitest';

const registerToolCalls = [];

vi.mock('../../../supabase/functions/ai-chat/registry.ts', () => ({
  registerTool: (def, handler, confirmedHandler) => {
    registerToolCalls.push({ def, handler, confirmedHandler });
  },
}));

beforeAll(async () => {
  // Load the module under test — registerTool side-effects populate
  // the captured-calls array.
  await import('../../../supabase/functions/ai-chat/tools/tasks.ts');
});

function findTool(name) {
  return registerToolCalls.find((c) => c.def.name === name);
}

// ─── Tool registration shape ─────────────────────────────────

describe('tasks tool registration', () => {
  it('registers list_follow_ups as an auto tool', () => {
    const t = findTool('list_follow_ups');
    expect(t).toBeDefined();
    expect(t.def.riskLevel).toBe('auto');
    expect(t.def.input_schema.type).toBe('object');
    expect(t.confirmedHandler).toBeUndefined();
  });

  it('registers create_follow_up as a confirm tool with title + due_at required', () => {
    const t = findTool('create_follow_up');
    expect(t).toBeDefined();
    expect(t.def.riskLevel).toBe('confirm');
    expect(t.def.input_schema.required).toEqual(['title', 'due_at']);
    expect(t.confirmedHandler).toBeInstanceOf(Function);
  });

  it('registers complete_follow_up as a confirm tool with task_id required', () => {
    const t = findTool('complete_follow_up');
    expect(t).toBeDefined();
    expect(t.def.riskLevel).toBe('confirm');
    expect(t.def.input_schema.required).toEqual(['task_id']);
    expect(t.confirmedHandler).toBeInstanceOf(Function);
  });

  it('uses distinct names from caregiver-write.complete_task (no registry collision)', () => {
    const names = registerToolCalls.map((c) => c.def.name);
    expect(names).not.toContain('complete_task');
    expect(names).not.toContain('create_task');
    expect(names).not.toContain('list_tasks');
  });
});

// ─── list_follow_ups handler ─────────────────────────────────

describe('list_follow_ups handler', () => {
  function makeCtx({ caregivers = [], clients = [], mailbox = 'jess@tc', data = [] } = {}) {
    const calls = [];
    let chainState = {};
    // Thenable chain — every chainable method returns `chain`; the
    // final await triggers the then() which resolves with the
    // captured data. This matches Supabase JS's PostgrestBuilder
    // contract (builders are themselves thenables).
    const builder = () => {
      chainState = {
        statusIn: null,
        statusEq: null,
        order: null,
        limit: null,
        ltDueAt: null,
        lteDueAt: null,
        eqAssigned: null,
        eqCaregiver: null,
        eqClient: null,
      };
      const chain = {
        select() { return chain; },
        in(col, vals) { if (col === 'status') chainState.statusIn = vals; return chain; },
        eq(col, val) {
          if (col === 'status') chainState.statusEq = val;
          if (col === 'assigned_to') chainState.eqAssigned = val;
          if (col === 'caregiver_id') chainState.eqCaregiver = val;
          if (col === 'client_id') chainState.eqClient = val;
          return chain;
        },
        lt(col, val) { if (col === 'due_at') chainState.ltDueAt = val; return chain; },
        lte(col, val) { if (col === 'due_at') chainState.lteDueAt = val; return chain; },
        order(col, opts) { chainState.order = { col, opts }; return chain; },
        limit(n) { chainState.limit = n; return chain; },
        then(resolve) { return resolve({ data, error: null }); },
      };
      return chain;
    };
    return {
      supabase: { from: (table) => { calls.push(table); return builder(); } },
      caregivers, clients,
      currentUser: 'Jessica',
      currentUserMailbox: mailbox,
      _calls: calls,
      get _state() { return chainState; },
    };
  }

  it('defaults to scope=mine, bucket=today, filtered by current-user email', async () => {
    const t = findTool('list_follow_ups');
    const ctx = makeCtx();
    await t.handler({}, ctx);
    expect(ctx._calls).toContain('follow_up_tasks');
    expect(ctx._state.statusIn).toEqual(['pending']);
    expect(ctx._state.eqAssigned).toBe('jess@tc');
    expect(ctx._state.lteDueAt).toBeTruthy(); // bucket=today uses lte
    expect(ctx._state.limit).toBe(10);
  });

  it('respects scope=all (no assignee filter)', async () => {
    const t = findTool('list_follow_ups');
    const ctx = makeCtx();
    await t.handler({ scope: 'all' }, ctx);
    expect(ctx._state.eqAssigned).toBeNull();
  });

  it('overdue bucket uses lt (strict less than now)', async () => {
    const t = findTool('list_follow_ups');
    const ctx = makeCtx();
    await t.handler({ bucket: 'overdue' }, ctx);
    expect(ctx._state.ltDueAt).toBeTruthy();
    expect(ctx._state.lteDueAt).toBeNull();
  });

  it('all_open bucket pulls both pending + snoozed and no time filter', async () => {
    const t = findTool('list_follow_ups');
    const ctx = makeCtx();
    await t.handler({ bucket: 'all_open' }, ctx);
    expect(ctx._state.statusIn).toEqual(['pending', 'snoozed']);
    expect(ctx._state.lteDueAt).toBeNull();
    expect(ctx._state.ltDueAt).toBeNull();
  });

  it('caps limit at 20', async () => {
    const t = findTool('list_follow_ups');
    const ctx = makeCtx();
    await t.handler({ limit: 500 }, ctx);
    expect(ctx._state.limit).toBe(20);
  });

  it('filters by caregiver_id when provided', async () => {
    const t = findTool('list_follow_ups');
    const ctx = makeCtx();
    await t.handler({ caregiver_id: 'cg-7' }, ctx);
    expect(ctx._state.eqCaregiver).toBe('cg-7');
  });
});

// ─── create_follow_up handler (pre-confirm path) ─────────────

describe('create_follow_up pre-confirm', () => {
  const baseCtx = {
    supabase: {},
    caregivers: [{ id: 'cg-1', first_name: 'Maria', last_name: 'Lopez' }],
    clients: [{ id: 'cl-1', first_name: 'John', last_name: 'Doe' }],
    currentUser: 'Jessica',
    currentUserMailbox: 'jess@tc',
  };

  it('rejects missing title', async () => {
    const t = findTool('create_follow_up');
    const out = await t.handler({ due_at: '2026-06-15T09:00:00Z' }, baseCtx);
    expect(out.error).toMatch(/title/i);
  });

  it('rejects missing due_at', async () => {
    const t = findTool('create_follow_up');
    const out = await t.handler({ title: 'x' }, baseCtx);
    expect(out.error).toMatch(/due_at/);
  });

  it('rejects invalid ISO due_at', async () => {
    const t = findTool('create_follow_up');
    const out = await t.handler({ title: 'x', due_at: 'tomorrow' }, baseCtx);
    expect(out.error).toMatch(/not a valid ISO/);
  });

  it('rejects bad urgency', async () => {
    const t = findTool('create_follow_up');
    const out = await t.handler({ title: 'x', due_at: '2026-06-15T09:00:00Z', urgency: 'high' }, baseCtx);
    expect(out.error).toMatch(/urgency/);
  });

  it('rejects linking both caregiver + client', async () => {
    const t = findTool('create_follow_up');
    const out = await t.handler({
      title: 'x', due_at: '2026-06-15T09:00:00Z',
      caregiver_id: 'cg-1', client_id: 'cl-1',
    }, baseCtx);
    expect(out.error).toMatch(/caregiver OR a client/);
  });

  it('returns requires_confirmation with the resolved entity name', async () => {
    const t = findTool('create_follow_up');
    const out = await t.handler({
      title: 'Call Maria',
      due_at: '2026-06-15T09:00:00Z',
      caregiver_id: 'cg-1',
    }, baseCtx);
    expect(out.requires_confirmation).toBe(true);
    expect(out.action).toBe('create_follow_up');
    expect(out.summary).toContain('Maria Lopez');
    expect(out.params.title).toBe('Call Maria');
    expect(out.params.caregiver_id).toBe('cg-1');
    expect(out.params.assigned_to).toBe('jess@tc');
  });
});

// ─── create_follow_up confirmed handler ──────────────────────

describe('create_follow_up confirmed handler', () => {
  function makeInsertingClient({ insertError = null, returnedId = 'task-new' } = {}) {
    const inserts = [];
    return {
      from(table) {
        return {
          insert(row) {
            inserts.push({ table, row });
            if (table === 'events') {
              // Events insert returns void
              return Promise.resolve({ data: null, error: null });
            }
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({
                      data: insertError ? null : { id: returnedId },
                      error: insertError,
                    });
                  },
                };
              },
            };
          },
        };
      },
      _inserts: inserts,
    };
  }

  it('inserts source=ai with created_by audit + emits task_created event', async () => {
    const t = findTool('create_follow_up');
    const client = makeInsertingClient();
    const out = await t.confirmedHandler(
      'create_follow_up',
      '__no_caregiver__',
      {
        title: 'Call Maria',
        due_at: '2026-06-15T09:00:00.000Z',
        urgency: 'warning',
        description: null,
        caregiver_id: 'cg-1',
        client_id: null,
        assigned_to: 'jess@tc',
      },
      client,
      'Jessica',
      'jess@tc',
    );
    expect(out.success).toBe(true);
    expect(out.task_id).toBe('task-new');

    const taskInsert = client._inserts.find((i) => i.table === 'follow_up_tasks');
    expect(taskInsert.row.source).toBe('ai');
    expect(taskInsert.row.title).toBe('Call Maria');
    expect(taskInsert.row.assigned_to).toBe('jess@tc');
    expect(taskInsert.row.created_by).toBe('ai:jess@tc');

    const evt = client._inserts.find((i) => i.table === 'events');
    expect(evt.row.event_type).toBe('task_created');
    expect(evt.row.entity_type).toBe('caregiver');
    expect(evt.row.actor).toBe('ai:jess@tc');
  });

  it('propagates DB shape-CHECK errors verbatim', async () => {
    const t = findTool('create_follow_up');
    const client = makeInsertingClient({
      insertError: { message: 'new row violates check constraint "follow_up_tasks_shape_check"' },
    });
    const out = await t.confirmedHandler(
      'create_follow_up',
      '__no_caregiver__',
      { title: 'x', due_at: 'x', urgency: 'warning', caregiver_id: null, client_id: null, assigned_to: 'a' },
      client,
      'Jessica',
      'jess@tc',
    );
    expect(out.error).toMatch(/shape_check/);
  });
});

// ─── complete_follow_up handler ──────────────────────────────

describe('complete_follow_up handler', () => {
  function makeCtxWithTask(task) {
    return {
      supabase: {
        from(table) {
          return {
            select() {
              return {
                eq() {
                  return {
                    maybeSingle() {
                      return Promise.resolve({ data: task, error: null });
                    },
                  };
                },
              };
            },
          };
        },
      },
      caregivers: [{ id: 'cg-1', first_name: 'Maria', last_name: 'Lopez' }],
      clients: [],
      currentUser: 'Jessica',
      currentUserMailbox: 'jess@tc',
    };
  }

  it('rejects missing task_id', async () => {
    const t = findTool('complete_follow_up');
    const ctx = makeCtxWithTask(null);
    const out = await t.handler({}, ctx);
    expect(out.error).toMatch(/task_id/);
  });

  it('errors when the task does not exist', async () => {
    const t = findTool('complete_follow_up');
    const ctx = makeCtxWithTask(null);
    const out = await t.handler({ task_id: 'missing' }, ctx);
    expect(out.error).toMatch(/No task found/);
  });

  it('refuses to confirm a non-open task', async () => {
    const t = findTool('complete_follow_up');
    const ctx = makeCtxWithTask({
      id: 'task-1', status: 'done', title: 'x', due_at: '2026-06-15T09:00:00Z',
      caregiver_id: null, client_id: null,
    });
    const out = await t.handler({ task_id: 'task-1' }, ctx);
    expect(out.error).toMatch(/already done/);
  });

  it('returns requires_confirmation with the resolved task summary', async () => {
    const t = findTool('complete_follow_up');
    const ctx = makeCtxWithTask({
      id: 'task-1', status: 'pending', title: 'Call Maria',
      due_at: '2026-06-15T09:00:00Z',
      caregiver_id: 'cg-1', client_id: null,
      follow_up_templates: null,
    });
    const out = await t.handler({ task_id: 'task-1', completion_note: 'Done via SMS' }, ctx);
    expect(out.requires_confirmation).toBe(true);
    expect(out.action).toBe('complete_follow_up');
    expect(out.summary).toContain('Maria Lopez');
    expect(out.summary).toContain('Done via SMS');
    expect(out.params.task_id).toBe('task-1');
    expect(out.params.completion_note).toBe('Done via SMS');
  });
});
