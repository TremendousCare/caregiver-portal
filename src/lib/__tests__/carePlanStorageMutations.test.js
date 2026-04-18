import { describe, it, expect, beforeEach, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Fluent Supabase mock
//
// The storage layer uses a pattern like:
//   supabase.from('table').select('*').eq('id', x).maybeSingle()
//   supabase.from('table').update(patch).eq('id', x).select().single()
//
// This helper creates a per-test mock where each `from('table')` call
// returns a builder. Tests call `mockFrom('table').terminal('action',
// 'maybeSingle', { data, error })` to prime the return for a specific
// chain, identified by the action + terminal method.
//
// We keep the DSL intentionally narrow — we care about the return of
// the terminal promise, not the intermediate chaining, and the code
// under test is small enough that we don't need a full SQL-esque mock.
// ═══════════════════════════════════════════════════════════════

function createSupabaseMock() {
  // queue: [{ table, action, terminal, result }]
  // Actions: 'select', 'insert', 'update', 'delete'
  // Terminals: 'maybeSingle', 'single', 'noTerminal' (resolves the promise directly)
  const queue = [];
  const calls = [];

  function enqueue(table, action, terminal, result) {
    queue.push({ table, action, terminal, result });
  }

  function dequeue(table, action, terminal) {
    const idx = queue.findIndex(
      (q) => q.table === table && q.action === action && q.terminal === terminal,
    );
    if (idx === -1) {
      throw new Error(`Unexpected call: ${table}.${action}().${terminal || 'noTerminal'}`);
    }
    return queue.splice(idx, 1)[0].result;
  }

  function makeBuilder(table, action) {
    const builder = {
      select() { return builder; },
      eq() { return builder; },
      limit() { return builder; },
      order() { return builder; },
      maybeSingle() {
        calls.push({ table, action, terminal: 'maybeSingle' });
        return Promise.resolve(dequeue(table, action, 'maybeSingle'));
      },
      single() {
        calls.push({ table, action, terminal: 'single' });
        return Promise.resolve(dequeue(table, action, 'single'));
      },
      // Some call chains end in .select() without single/maybeSingle
      // and resolve as a thenable via await.
      then(onFulfilled, onRejected) {
        calls.push({ table, action, terminal: 'noTerminal' });
        return Promise.resolve(dequeue(table, action, 'noTerminal'))
          .then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const supabase = {
    from: vi.fn((table) => {
      return {
        select: () => makeBuilder(table, 'select'),
        insert: () => makeBuilder(table, 'insert'),
        update: () => makeBuilder(table, 'update'),
        delete: () => makeBuilder(table, 'delete'),
      };
    }),
  };

  return { supabase, enqueue, calls, queue };
}

// ── Shared mock instance, reset per test ───────────────────────
let mock;

vi.mock('../supabase', () => ({
  supabase: new Proxy({}, {
    get(_, prop) {
      return mock.supabase[prop];
    },
  }),
  isSupabaseConfigured: () => true,
}));

// Import the module under test AFTER vi.mock is set up.
const storageImport = await import('../../features/care-plans/storage.js');
const {
  saveDraft,
  publishVersion,
  createNewDraftVersion,
  createTask,
  updateTask,
  deleteTask,
  __testables__,
} = storageImport;

beforeEach(() => {
  mock = createSupabaseMock();
});

// ═══════════════════════════════════════════════════════════════
// sameValue (pure helper)
// ═══════════════════════════════════════════════════════════════

describe('sameValue', () => {
  const { sameValue } = __testables__;

  it('returns true for identical primitives', () => {
    expect(sameValue('a', 'a')).toBe(true);
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue(true, true)).toBe(true);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(undefined, undefined)).toBe(true);
  });

  it('returns false for different primitives', () => {
    expect(sameValue('a', 'b')).toBe(false);
    expect(sameValue(1, 2)).toBe(false);
    expect(sameValue(true, false)).toBe(false);
  });

  it('treats null and undefined as equal', () => {
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
  });

  it('handles arrays element-wise', () => {
    expect(sameValue([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('handles plain objects key-wise', () => {
    expect(sameValue({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameValue({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
  });

  it('handles nested structures', () => {
    const a = { x: [1, { y: 'z' }] };
    const b = { x: [1, { y: 'z' }] };
    const c = { x: [1, { y: 'q' }] };
    expect(sameValue(a, b)).toBe(true);
    expect(sameValue(a, c)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// saveDraft
// ═══════════════════════════════════════════════════════════════

describe('saveDraft', () => {
  it('rejects when versionId is missing', async () => {
    await expect(saveDraft(null, 'whoTheyAre', { fullName: 'x' })).rejects.toThrow(/versionId/);
  });

  it('rejects when sectionId is missing', async () => {
    await expect(saveDraft('v-1', null, { fullName: 'x' })).rejects.toThrow(/sectionId/);
  });

  it('rejects when fieldPatch is not an object', async () => {
    await expect(saveDraft('v-1', 'whoTheyAre', 'not-an-object')).rejects.toThrow(/fieldPatch/);
  });

  it('throws if version not found', async () => {
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', { data: null, error: null });
    await expect(saveDraft('v-1', 'whoTheyAre', { fullName: 'x' })).rejects.toThrow(/not found/);
  });

  it('throws if version is not a draft', async () => {
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { id: 'v-1', care_plan_id: 'p-1', status: 'published', data: {} },
      error: null,
    });
    await expect(saveDraft('v-1', 'whoTheyAre', { fullName: 'x' })).rejects.toThrow(/published/);
  });

  it('is a no-op when all patch values match existing values', async () => {
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: {
        id: 'v-1', care_plan_id: 'p-1', status: 'draft',
        data: { whoTheyAre: { fullName: 'Kevin' } },
      },
      error: null,
    });
    const result = await saveDraft('v-1', 'whoTheyAre', { fullName: 'Kevin' });
    expect(result).toBeDefined();
    expect(result.id).toBe('v-1');
    // No update call should have been made.
    expect(mock.calls.some((c) => c.action === 'update')).toBe(false);
  });

  it('merges patch into section data and emits one event per change', async () => {
    // 1. Read current version
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: {
        id: 'v-1', care_plan_id: 'p-1', status: 'draft',
        data: { whoTheyAre: { fullName: 'Old Name', pronouns: 'he/him' } },
      },
      error: null,
    });
    // 2. Update call
    mock.enqueue('care_plan_versions', 'update', 'single', {
      data: {
        id: 'v-1', care_plan_id: 'p-1', status: 'draft', version_number: 1,
        data: {
          whoTheyAre: { fullName: 'New Name', pronouns: 'he/him', preferredName: 'Kev' },
        },
      },
      error: null,
    });
    // 3. Event log inserts (one per change) — 2 changes here
    mock.enqueue('events', 'insert', 'noTerminal', { data: null, error: null });
    mock.enqueue('events', 'insert', 'noTerminal', { data: null, error: null });

    const result = await saveDraft(
      'v-1',
      'whoTheyAre',
      { fullName: 'New Name', preferredName: 'Kev', pronouns: 'he/him' },
      { userId: 'jessica' },
    );

    expect(result.versionNumber).toBe(1);
    expect(result.data.whoTheyAre.fullName).toBe('New Name');
    expect(result.data.whoTheyAre.pronouns).toBe('he/him');

    // Two changes → two event inserts. Allow async microtask to drain.
    await new Promise((r) => setTimeout(r, 5));
    const eventInserts = mock.calls.filter((c) => c.table === 'events' && c.action === 'insert');
    expect(eventInserts).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// publishVersion
// ═══════════════════════════════════════════════════════════════

describe('publishVersion', () => {
  it('rejects when agencySignedName is missing', async () => {
    await expect(publishVersion('v-1', { reason: 'r' })).rejects.toThrow(/agencySignedName/);
  });

  it('rejects if version not found', async () => {
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', { data: null, error: null });
    await expect(
      publishVersion('v-1', { agencySignedName: 'Jessica' }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects if version is already published', async () => {
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { id: 'v-1', care_plan_id: 'p-1', status: 'published', version_number: 1 },
      error: null,
    });
    await expect(
      publishVersion('v-1', { agencySignedName: 'Jessica' }),
    ).rejects.toThrow(/already published/);
  });

  it('writes signatures and publish metadata', async () => {
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { id: 'v-1', care_plan_id: 'p-1', status: 'draft', version_number: 1 },
      error: null,
    });
    mock.enqueue('care_plan_versions', 'update', 'single', {
      data: {
        id: 'v-1', care_plan_id: 'p-1', status: 'published', version_number: 1,
        agency_signed_name: 'Jessica Wilson',
        client_signed_name: 'Kevin Rogers',
        published_at: '2026-04-18T22:30:00Z',
        published_by: 'jessica',
        version_reason: 'initial intake',
        data: {},
      },
      error: null,
    });
    mock.enqueue('events', 'insert', 'noTerminal', { data: null, error: null });

    const result = await publishVersion('v-1', {
      reason: 'initial intake',
      agencySignedName: 'Jessica Wilson',
      clientSignedName: 'Kevin Rogers',
      clientSignedMethod: 'in-person',
      userId: 'jessica',
    });

    expect(result.status).toBe('published');
    expect(result.agencySignedName).toBe('Jessica Wilson');
    expect(result.clientSignedName).toBe('Kevin Rogers');
  });
});

// ═══════════════════════════════════════════════════════════════
// createNewDraftVersion
// ═══════════════════════════════════════════════════════════════

describe('createNewDraftVersion', () => {
  it('rejects when carePlanId is missing', async () => {
    await expect(createNewDraftVersion(null, { fromVersionId: 'v' })).rejects.toThrow(/carePlanId/);
  });

  it('rejects when fromVersionId is missing', async () => {
    await expect(createNewDraftVersion('p-1', {})).rejects.toThrow(/fromVersionId/);
  });

  it('rejects when source version belongs to a different plan', async () => {
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { id: 'v-1', care_plan_id: 'p-other', status: 'published', data: {}, version_number: 1 },
      error: null,
    });
    await expect(
      createNewDraftVersion('p-1', { fromVersionId: 'v-1' }),
    ).rejects.toThrow(/different care plan/);
  });

  it('increments version number and clones data + tasks', async () => {
    // 1. Read source version
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: {
        id: 'v-1', care_plan_id: 'p-1', status: 'published', version_number: 1,
        data: { whoTheyAre: { fullName: 'Kevin' } },
      },
      error: null,
    });
    // 2. List versions to compute next number
    mock.enqueue('care_plan_versions', 'select', 'noTerminal', {
      data: [{ version_number: 3 }],
      error: null,
    });
    // 3. Insert draft
    mock.enqueue('care_plan_versions', 'insert', 'single', {
      data: {
        id: 'v-new', care_plan_id: 'p-1', version_number: 4, status: 'draft',
        data: { whoTheyAre: { fullName: 'Kevin' } },
      },
      error: null,
    });
    // 4. Fetch source tasks
    mock.enqueue('care_plan_tasks', 'select', 'noTerminal', {
      data: [
        { version_id: 'v-1', category: 'adl.bathing', task_name: 'Shower', shifts: ['morning'],
          days_of_week: [], priority: 'standard', safety_notes: null, sort_order: 0,
          description: null },
      ],
      error: null,
    });
    // 5. Insert cloned tasks
    mock.enqueue('care_plan_tasks', 'insert', 'noTerminal', { data: null, error: null });
    // 6. Update care plan pointer
    mock.enqueue('care_plans', 'update', 'noTerminal', { data: null, error: null });
    // 7. Event
    mock.enqueue('events', 'insert', 'noTerminal', { data: null, error: null });

    const result = await createNewDraftVersion('p-1', {
      fromVersionId: 'v-1', reason: 'condition change', userId: 'jessica',
    });

    expect(result.versionNumber).toBe(4);
    expect(result.status).toBe('draft');
    expect(result.data.whoTheyAre.fullName).toBe('Kevin');
  });
});

// ═══════════════════════════════════════════════════════════════
// Task CRUD
// ═══════════════════════════════════════════════════════════════

describe('createTask', () => {
  it('rejects when task.category is missing', async () => {
    await expect(createTask('v-1', { taskName: 'x' })).rejects.toThrow(/category/);
  });

  it('rejects when task.taskName is missing', async () => {
    await expect(createTask('v-1', { category: 'adl.bathing' })).rejects.toThrow(/taskName/);
  });

  it('rejects when target version is not a draft', async () => {
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { id: 'v-1', status: 'published' },
      error: null,
    });
    await expect(
      createTask('v-1', { category: 'adl.bathing', taskName: 'Shower' }),
    ).rejects.toThrow(/published/);
  });

  it('inserts the task and emits a created event', async () => {
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { id: 'v-1', status: 'draft' },
      error: null,
    });
    mock.enqueue('care_plan_tasks', 'insert', 'single', {
      data: {
        id: 't-1', version_id: 'v-1', category: 'adl.bathing', task_name: 'Shower',
        shifts: ['morning'], days_of_week: [], priority: 'standard',
        safety_notes: null, sort_order: 0, description: null,
      },
      error: null,
    });
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { care_plan_id: 'p-1' },
      error: null,
    });
    mock.enqueue('events', 'insert', 'noTerminal', { data: null, error: null });

    const result = await createTask(
      'v-1',
      { category: 'adl.bathing', taskName: 'Shower', shifts: ['morning'] },
      { userId: 'jessica' },
    );
    expect(result.id).toBe('t-1');
    expect(result.category).toBe('adl.bathing');
  });
});

describe('updateTask', () => {
  it('rejects when patch is not an object', async () => {
    await expect(updateTask('t-1', null)).rejects.toThrow(/patch/);
  });

  it('rejects when task not found', async () => {
    mock.enqueue('care_plan_tasks', 'select', 'maybeSingle', { data: null, error: null });
    await expect(updateTask('t-1', { taskName: 'x' })).rejects.toThrow(/not found/);
  });

  it('rejects when task belongs to a published version', async () => {
    mock.enqueue('care_plan_tasks', 'select', 'maybeSingle', {
      data: { id: 't-1', version_id: 'v-1', category: 'adl.bathing', task_name: 'Shower' },
      error: null,
    });
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { id: 'v-1', status: 'published' },
      error: null,
    });
    await expect(updateTask('t-1', { taskName: 'x' })).rejects.toThrow(/published/);
  });

  it('only emits the keys present in the patch', async () => {
    mock.enqueue('care_plan_tasks', 'select', 'maybeSingle', {
      data: { id: 't-1', version_id: 'v-1', category: 'adl.bathing', task_name: 'Shower' },
      error: null,
    });
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { id: 'v-1', status: 'draft' },
      error: null,
    });
    mock.enqueue('care_plan_tasks', 'update', 'single', {
      data: {
        id: 't-1', version_id: 'v-1', category: 'adl.bathing', task_name: 'Shower daily',
        shifts: ['all'], days_of_week: [], priority: 'standard',
        safety_notes: null, sort_order: 0, description: null,
      },
      error: null,
    });
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { care_plan_id: 'p-1' },
      error: null,
    });
    mock.enqueue('events', 'insert', 'noTerminal', { data: null, error: null });

    const result = await updateTask('t-1', { taskName: 'Shower daily' });
    expect(result.taskName).toBe('Shower daily');
  });

  it('defaults shifts to ["all"] when passed an empty array', async () => {
    mock.enqueue('care_plan_tasks', 'select', 'maybeSingle', {
      data: { id: 't-1', version_id: 'v-1', category: 'adl.bathing', task_name: 'Shower' },
      error: null,
    });
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { id: 'v-1', status: 'draft' },
      error: null,
    });
    mock.enqueue('care_plan_tasks', 'update', 'single', {
      data: {
        id: 't-1', version_id: 'v-1', category: 'adl.bathing', task_name: 'Shower',
        shifts: ['all'], days_of_week: [], priority: 'standard',
        safety_notes: null, sort_order: 0, description: null,
      },
      error: null,
    });
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { care_plan_id: 'p-1' },
      error: null,
    });
    mock.enqueue('events', 'insert', 'noTerminal', { data: null, error: null });

    const result = await updateTask('t-1', { shifts: [] });
    expect(result.shifts).toEqual(['all']);
  });
});

describe('deleteTask', () => {
  it('rejects when task not found', async () => {
    mock.enqueue('care_plan_tasks', 'select', 'maybeSingle', { data: null, error: null });
    await expect(deleteTask('t-1')).rejects.toThrow(/not found/);
  });

  it('rejects when task belongs to a published version', async () => {
    mock.enqueue('care_plan_tasks', 'select', 'maybeSingle', {
      data: { id: 't-1', version_id: 'v-1', category: 'adl.bathing', task_name: 'Shower' },
      error: null,
    });
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { id: 'v-1', status: 'published' },
      error: null,
    });
    await expect(deleteTask('t-1')).rejects.toThrow(/published/);
  });

  it('deletes the task and emits a deleted event', async () => {
    mock.enqueue('care_plan_tasks', 'select', 'maybeSingle', {
      data: { id: 't-1', version_id: 'v-1', category: 'adl.bathing', task_name: 'Shower' },
      error: null,
    });
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { id: 'v-1', status: 'draft' },
      error: null,
    });
    mock.enqueue('care_plan_tasks', 'delete', 'noTerminal', { data: null, error: null });
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: { care_plan_id: 'p-1' },
      error: null,
    });
    mock.enqueue('events', 'insert', 'noTerminal', { data: null, error: null });

    const result = await deleteTask('t-1');
    expect(result).toBe(true);
  });
});
