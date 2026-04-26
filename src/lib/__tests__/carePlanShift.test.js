import { describe, it, expect, beforeEach, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Fluent Supabase mock — matches the pattern used by
// carePlanStorageMutations.test.js so the storage helpers under test
// don't see anything novel about their environment.
// ═══════════════════════════════════════════════════════════════

function createSupabaseMock() {
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

  function makeBuilder(table, action, payload) {
    const builder = {
      select() { return builder; },
      eq() { return builder; },
      limit() { return builder; },
      order() { return builder; },
      maybeSingle() {
        calls.push({ table, action, terminal: 'maybeSingle', payload });
        return Promise.resolve(dequeue(table, action, 'maybeSingle'));
      },
      single() {
        calls.push({ table, action, terminal: 'single', payload });
        return Promise.resolve(dequeue(table, action, 'single'));
      },
      then(onFulfilled, onRejected) {
        calls.push({ table, action, terminal: 'noTerminal', payload });
        return Promise.resolve(dequeue(table, action, 'noTerminal'))
          .then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const supabase = {
    from: vi.fn((table) => ({
      select: () => makeBuilder(table, 'select'),
      insert: (payload) => makeBuilder(table, 'insert', payload),
      update: (payload) => makeBuilder(table, 'update', payload),
      delete: () => makeBuilder(table, 'delete'),
    })),
  };

  return { supabase, enqueue, calls };
}

let mock;

vi.mock('../supabase', () => ({
  supabase: new Proxy({}, { get: (_, prop) => mock.supabase[prop] }),
  isSupabaseConfigured: () => true,
}));

const {
  loadCarePlanForShift,
  logTaskObservation,
  logShiftNote,
  logRefusal,
  indexLatestTaskCompletions,
  pickLatestShiftNote,
  listRefusals,
  dbToObservation,
} = await import('../carePlanShift.js');

beforeEach(() => {
  mock = createSupabaseMock();
});

// ─── loadCarePlanForShift ────────────────────────────────────

describe('loadCarePlanForShift', () => {
  it('returns the empty shape when shift has no clientId', async () => {
    const out = await loadCarePlanForShift({ id: 's1' });
    expect(out).toEqual({ plan: null, version: null, tasks: [], observations: [] });
  });

  it('returns the empty shape when no active care plan exists', async () => {
    // getCarePlanForClient hits care_plans.select with .limit().
    mock.enqueue('care_plans', 'select', 'noTerminal', { data: [], error: null });
    const out = await loadCarePlanForShift({ id: 's1', clientId: 'c1' });
    expect(out).toEqual({ plan: null, version: null, tasks: [], observations: [] });
  });

  it('loads plan + version + tasks + observations on the happy path', async () => {
    // 1. care_plans select → one active plan
    mock.enqueue('care_plans', 'select', 'noTerminal', {
      data: [{
        id: 'plan-1',
        client_id: 'c1',
        status: 'active',
        current_version_id: 'ver-1',
        created_at: '2026-04-26T00:00:00Z',
        updated_at: '2026-04-26T00:00:00Z',
      }],
      error: null,
    });
    // 2. getVersion → care_plan_versions.maybeSingle
    mock.enqueue('care_plan_versions', 'select', 'maybeSingle', {
      data: {
        id: 'ver-1',
        care_plan_id: 'plan-1',
        version_number: 3,
        status: 'published',
        data: {},
        created_at: '2026-04-26T00:00:00Z',
        updated_at: '2026-04-26T00:00:00Z',
      },
      error: null,
    });
    // 3. getTasksForVersion → care_plan_tasks select (no terminal — await on chain)
    mock.enqueue('care_plan_tasks', 'select', 'noTerminal', {
      data: [
        {
          id: 'task-1', version_id: 'ver-1', category: 'adl.bathing',
          task_name: 'Shower', shifts: ['morning'], days_of_week: [],
          priority: 'standard', sort_order: 0,
          created_at: '2026-04-26T00:00:00Z', updated_at: '2026-04-26T00:00:00Z',
        },
      ],
      error: null,
    });
    // 4. care_plan_observations select for shift
    mock.enqueue('care_plan_observations', 'select', 'noTerminal', {
      data: [],
      error: null,
    });

    const out = await loadCarePlanForShift({ id: 's1', clientId: 'c1' });
    expect(out.plan?.id).toBe('plan-1');
    expect(out.version?.id).toBe('ver-1');
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0].id).toBe('task-1');
    expect(out.observations).toEqual([]);
  });

  it('returns empty tasks when plan has no current version', async () => {
    mock.enqueue('care_plans', 'select', 'noTerminal', {
      data: [{
        id: 'plan-1', client_id: 'c1', status: 'active',
        current_version_id: null,
        created_at: '2026-04-26T00:00:00Z', updated_at: '2026-04-26T00:00:00Z',
      }],
      error: null,
    });
    // No getVersion, no getTasksForVersion. Skip straight to observations.
    mock.enqueue('care_plan_observations', 'select', 'noTerminal', { data: [], error: null });

    const out = await loadCarePlanForShift({ id: 's1', clientId: 'c1' });
    expect(out.plan?.id).toBe('plan-1');
    expect(out.version).toBeNull();
    expect(out.tasks).toEqual([]);
  });
});

// ─── logTaskObservation ──────────────────────────────────────

describe('logTaskObservation', () => {
  it('inserts a task_completion row with the right shape', async () => {
    mock.enqueue('care_plan_observations', 'insert', 'single', {
      data: {
        id: 'obs-1', care_plan_id: 'plan-1', version_id: 'ver-1',
        task_id: 'task-1', shift_id: 's1', caregiver_id: 'cg-1',
        observation_type: 'task_completion', rating: 'done',
        note: null, logged_at: '2026-04-26T10:00:00Z',
        created_at: '2026-04-26T10:00:00Z', updated_at: '2026-04-26T10:00:00Z',
      },
      error: null,
    });

    const out = await logTaskObservation({
      carePlanId: 'plan-1', versionId: 'ver-1', taskId: 'task-1',
      shiftId: 's1', caregiverId: 'cg-1', rating: 'done',
    });

    expect(out.id).toBe('obs-1');
    expect(out.observationType).toBe('task_completion');
    expect(out.rating).toBe('done');

    const insertCall = mock.calls.find((c) => c.action === 'insert');
    expect(insertCall.payload).toMatchObject({
      care_plan_id: 'plan-1',
      version_id: 'ver-1',
      task_id: 'task-1',
      shift_id: 's1',
      caregiver_id: 'cg-1',
      observation_type: 'task_completion',
      rating: 'done',
      note: null,
    });
  });

  it('trims an optional note', async () => {
    mock.enqueue('care_plan_observations', 'insert', 'single', {
      data: { id: 'obs-1', observation_type: 'task_completion', rating: 'partial' },
      error: null,
    });

    await logTaskObservation({
      carePlanId: 'plan-1', versionId: 'ver-1', taskId: 'task-1',
      shiftId: 's1', caregiverId: 'cg-1', rating: 'partial',
      note: '  done with help  ',
    });

    const insertCall = mock.calls.find((c) => c.action === 'insert');
    expect(insertCall.payload.note).toBe('done with help');
  });

  it('throws on missing required fields', async () => {
    await expect(logTaskObservation({
      versionId: 'ver-1', taskId: 'task-1', shiftId: 's1',
      caregiverId: 'cg-1', rating: 'done',
    })).rejects.toThrow(/required/);
  });

  it('throws on invalid rating', async () => {
    await expect(logTaskObservation({
      carePlanId: 'plan-1', versionId: 'ver-1', taskId: 'task-1',
      shiftId: 's1', caregiverId: 'cg-1', rating: 'definitely',
    })).rejects.toThrow(/invalid rating/);
  });
});

// ─── logShiftNote ────────────────────────────────────────────

describe('logShiftNote', () => {
  it('inserts a shift_note with task_id null', async () => {
    mock.enqueue('care_plan_observations', 'insert', 'single', {
      data: {
        id: 'obs-2', observation_type: 'shift_note', task_id: null,
        note: 'Calm afternoon, ate well at lunch.',
        logged_at: '2026-04-26T15:00:00Z',
      },
      error: null,
    });

    const out = await logShiftNote({
      carePlanId: 'plan-1', versionId: 'ver-1',
      shiftId: 's1', caregiverId: 'cg-1',
      note: '  Calm afternoon, ate well at lunch.  ',
    });

    expect(out.observationType).toBe('shift_note');
    const insertCall = mock.calls.find((c) => c.action === 'insert');
    expect(insertCall.payload).toMatchObject({
      observation_type: 'shift_note',
      task_id: null,
      note: 'Calm afternoon, ate well at lunch.',
    });
  });

  it('throws when the note is empty / whitespace', async () => {
    await expect(logShiftNote({
      carePlanId: 'plan-1', versionId: 'ver-1',
      shiftId: 's1', caregiverId: 'cg-1', note: '   ',
    })).rejects.toThrow(/empty/);
  });
});

// ─── logRefusal ─────────────────────────────────────────────

describe('logRefusal', () => {
  it('inserts a refusal tied to a task', async () => {
    mock.enqueue('care_plan_observations', 'insert', 'single', {
      data: {
        id: 'obs-3', observation_type: 'refusal',
        task_id: 'task-1', shift_id: 's1',
        note: 'Said she felt nauseous, will try later.',
      },
      error: null,
    });

    const out = await logRefusal({
      carePlanId: 'plan-1', versionId: 'ver-1', taskId: 'task-1',
      shiftId: 's1', caregiverId: 'cg-1',
      note: 'Said she felt nauseous, will try later.',
    });

    expect(out.observationType).toBe('refusal');
    const insertCall = mock.calls.find((c) => c.action === 'insert');
    expect(insertCall.payload.task_id).toBe('task-1');
    expect(insertCall.payload.observation_type).toBe('refusal');
  });

  it('allows a refusal with no taskId (free-floating)', async () => {
    mock.enqueue('care_plan_observations', 'insert', 'single', {
      data: { id: 'obs-3', observation_type: 'refusal', task_id: null },
      error: null,
    });

    await logRefusal({
      carePlanId: 'plan-1', versionId: 'ver-1',
      shiftId: 's1', caregiverId: 'cg-1',
      note: 'Refused breakfast.',
    });

    const insertCall = mock.calls.find((c) => c.action === 'insert');
    expect(insertCall.payload.task_id).toBeNull();
  });

  it('throws when the reason is empty', async () => {
    await expect(logRefusal({
      carePlanId: 'plan-1', versionId: 'ver-1', taskId: 'task-1',
      shiftId: 's1', caregiverId: 'cg-1', note: '   ',
    })).rejects.toThrow(/empty/);
  });
});

// ─── Pure digest helpers ────────────────────────────────────

describe('indexLatestTaskCompletions', () => {
  it('keeps the most recent task_completion per task_id', () => {
    const observations = [
      {
        id: 'a', taskId: 'task-1', observationType: 'task_completion',
        rating: 'partial', loggedAt: '2026-04-26T10:00:00Z',
      },
      {
        id: 'b', taskId: 'task-1', observationType: 'task_completion',
        rating: 'done', loggedAt: '2026-04-26T11:00:00Z',
      },
      {
        id: 'c', taskId: 'task-2', observationType: 'task_completion',
        rating: 'not_done', loggedAt: '2026-04-26T10:30:00Z',
      },
      {
        id: 'd', taskId: null, observationType: 'shift_note',
        note: 'hi', loggedAt: '2026-04-26T11:30:00Z',
      },
    ];
    const index = indexLatestTaskCompletions(observations);
    expect(index.get('task-1').rating).toBe('done');
    expect(index.get('task-2').rating).toBe('not_done');
    expect(index.has(null)).toBe(false);
    expect(index.size).toBe(2);
  });

  it('returns an empty map for empty/null input', () => {
    expect(indexLatestTaskCompletions([]).size).toBe(0);
    expect(indexLatestTaskCompletions(null).size).toBe(0);
  });

  it('ignores rows without taskId', () => {
    const index = indexLatestTaskCompletions([
      { observationType: 'task_completion', taskId: null, rating: 'done', loggedAt: '2026-04-26T10:00:00Z' },
    ]);
    expect(index.size).toBe(0);
  });
});

describe('pickLatestShiftNote', () => {
  it('returns the most recent shift_note', () => {
    const out = pickLatestShiftNote([
      { id: 'a', observationType: 'shift_note', note: 'first', loggedAt: '2026-04-26T10:00:00Z' },
      { id: 'b', observationType: 'shift_note', note: 'second', loggedAt: '2026-04-26T11:00:00Z' },
      { id: 'c', observationType: 'task_completion', loggedAt: '2026-04-26T11:30:00Z' },
    ]);
    expect(out.id).toBe('b');
    expect(out.note).toBe('second');
  });

  it('returns null when there are no shift_note observations', () => {
    expect(pickLatestShiftNote([])).toBeNull();
    expect(pickLatestShiftNote(null)).toBeNull();
    expect(pickLatestShiftNote([{ observationType: 'task_completion', loggedAt: 'x' }])).toBeNull();
  });
});

describe('listRefusals', () => {
  it('returns refusals chronologically', () => {
    const refusals = listRefusals([
      { id: 'a', observationType: 'refusal', loggedAt: '2026-04-26T11:00:00Z' },
      { id: 'b', observationType: 'task_completion', loggedAt: '2026-04-26T11:30:00Z' },
      { id: 'c', observationType: 'refusal', loggedAt: '2026-04-26T10:30:00Z' },
    ]);
    expect(refusals.map((r) => r.id)).toEqual(['c', 'a']);
  });

  it('returns an empty array for empty/null input', () => {
    expect(listRefusals([])).toEqual([]);
    expect(listRefusals(null)).toEqual([]);
  });
});

// ─── dbToObservation mapper ──────────────────────────────────

describe('dbToObservation', () => {
  it('maps every field from snake_case to camelCase', () => {
    const out = dbToObservation({
      id: 'x', care_plan_id: 'p', version_id: 'v', task_id: 't',
      shift_id: 's', caregiver_id: 'c', observation_type: 'task_completion',
      rating: 'done', note: 'ok', logged_at: 'now',
      created_at: 'c1', updated_at: 'c2',
    });
    expect(out).toEqual({
      id: 'x', carePlanId: 'p', versionId: 'v', taskId: 't',
      shiftId: 's', caregiverId: 'c', observationType: 'task_completion',
      rating: 'done', note: 'ok', loggedAt: 'now',
      createdAt: 'c1', updatedAt: 'c2',
    });
  });

  it('returns null for null input', () => {
    expect(dbToObservation(null)).toBeNull();
  });

  it('defaults nullable fields to null', () => {
    const out = dbToObservation({
      id: 'x', care_plan_id: 'p', version_id: 'v',
      observation_type: 'general', logged_at: 'now',
      created_at: 'c1', updated_at: 'c2',
    });
    expect(out.taskId).toBeNull();
    expect(out.shiftId).toBeNull();
    expect(out.caregiverId).toBeNull();
    expect(out.rating).toBeNull();
    expect(out.note).toBeNull();
  });
});
