import { describe, it, expect, beforeEach, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Tests for office-staff clock_events mutations:
//   insertManualClockEvent  — adds a missed punch
//   updateClockEventTime    — corrects a wrong time, preserving
//                             original_occurred_at on the FIRST edit
//   deleteManualClockEvent  — removes an erroneous manual entry
//
// Each test stubs the Supabase client just enough to verify which
// queries the storage layer issued and what payload it sent.
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
    const filters = [];
    const builder = {
      select() { return builder; },
      eq(col, val) { filters.push({ col, val, op: 'eq' }); return builder; },
      in(col, vals) { filters.push({ col, val: vals, op: 'in' }); return builder; },
      order() { return builder; },
      single() {
        calls.push({ table, action, terminal: 'single', payload, filters });
        return Promise.resolve(dequeue(table, action, 'single'));
      },
      maybeSingle() {
        calls.push({ table, action, terminal: 'maybeSingle', payload, filters });
        return Promise.resolve(dequeue(table, action, 'maybeSingle'));
      },
      then(onFulfilled, onRejected) {
        calls.push({ table, action, terminal: 'noTerminal', payload, filters });
        return Promise.resolve(dequeue(table, action, 'noTerminal'))
          .then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const supabase = {
    from: vi.fn((table) => ({
      select: () => makeBuilder(table, 'select', null),
      insert: (payload) => makeBuilder(table, 'insert', payload),
      update: (payload) => makeBuilder(table, 'update', payload),
      delete: () => makeBuilder(table, 'delete', null),
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
  insertManualClockEvent,
  updateClockEventTime,
  deleteManualClockEvent,
  getClockEventsForShift,
  getClockEventsSummaryForShifts,
} = await import('../../features/scheduling/storage.js');

beforeEach(() => {
  mock = createSupabaseMock();
});

// ─── insertManualClockEvent ────────────────────────────────────

describe('insertManualClockEvent', () => {
  it('inserts a row with source="manual_entry" and stamps editedBy', async () => {
    mock.enqueue('clock_events', 'insert', 'single', {
      data: {
        id: 'evt-new',
        shift_id: 'shift-A',
        caregiver_id: 'cg-9',
        event_type: 'in',
        occurred_at: '2026-05-04T15:00:00.000Z',
        source: 'manual_entry',
        edited_by: 'Jessica',
        edit_reason: 'Caregiver forgot to clock in',
        created_at: '2026-05-04T20:00:00.000Z',
      },
      error: null,
    });

    const out = await insertManualClockEvent({
      shiftId: 'shift-A',
      caregiverId: 'cg-9',
      eventType: 'in',
      occurredAt: '2026-05-04T15:00:00.000Z',
      editedBy: 'Jessica',
      editReason: 'Caregiver forgot to clock in',
    });

    expect(out.id).toBe('evt-new');
    expect(out.source).toBe('manual_entry');
    expect(out.editedBy).toBe('Jessica');

    // Verify the actual payload sent to Supabase.
    const insert = mock.calls.find((c) => c.action === 'insert');
    expect(insert.payload).toMatchObject({
      shift_id: 'shift-A',
      caregiver_id: 'cg-9',
      event_type: 'in',
      occurred_at: '2026-05-04T15:00:00.000Z',
      source: 'manual_entry',
      edited_by: 'Jessica',
      edit_reason: 'Caregiver forgot to clock in',
    });
  });

  it('rejects missing required fields without hitting the network', async () => {
    await expect(
      insertManualClockEvent({ shiftId: 'shift-A', caregiverId: 'cg-9', eventType: 'in' }),
    ).rejects.toThrow(/Missing required fields/);
    expect(mock.calls.length).toBe(0);
  });

  it('rejects an invalid event type', async () => {
    await expect(
      insertManualClockEvent({
        shiftId: 'shift-A',
        caregiverId: 'cg-9',
        eventType: 'lunch',
        occurredAt: '2026-05-04T15:00:00.000Z',
      }),
    ).rejects.toThrow(/eventType must be/);
  });
});

// ─── updateClockEventTime ──────────────────────────────────────

describe('updateClockEventTime', () => {
  it('preserves original_occurred_at on the FIRST edit (was null before)', async () => {
    // Pre-edit state: row was auto-recorded by the edge function, never edited
    mock.enqueue('clock_events', 'select', 'single', {
      data: {
        occurred_at: '2026-05-04T15:35:00.000Z',
        original_occurred_at: null,
      },
      error: null,
    });
    // The update() call returns the new row
    mock.enqueue('clock_events', 'update', 'single', {
      data: {
        id: 'evt-1',
        shift_id: 'shift-A',
        caregiver_id: 'cg-9',
        event_type: 'in',
        occurred_at: '2026-05-04T15:00:00.000Z',
        source: 'caregiver_app',
        edited_by: 'Jessica',
        edit_reason: 'Correcting per caregiver report',
        original_occurred_at: '2026-05-04T15:35:00.000Z',
        created_at: '2026-05-04T15:35:01.000Z',
      },
      error: null,
    });

    const out = await updateClockEventTime('evt-1', {
      occurredAt: '2026-05-04T15:00:00.000Z',
      editedBy: 'Jessica',
      editReason: 'Correcting per caregiver report',
    });

    expect(out.occurredAt).toBe('2026-05-04T15:00:00.000Z');
    expect(out.originalOccurredAt).toBe('2026-05-04T15:35:00.000Z');

    const updateCall = mock.calls.find((c) => c.action === 'update');
    expect(updateCall.payload.original_occurred_at).toBe('2026-05-04T15:35:00.000Z');
    expect(updateCall.payload.occurred_at).toBe('2026-05-04T15:00:00.000Z');
    expect(updateCall.payload.edited_by).toBe('Jessica');
    expect(updateCall.payload.edit_reason).toBe('Correcting per caregiver report');
    expect(typeof updateCall.payload.edited_at).toBe('string');
  });

  it('does NOT overwrite original_occurred_at on a SECOND edit', async () => {
    // Pre-edit state: row was already edited once
    mock.enqueue('clock_events', 'select', 'single', {
      data: {
        occurred_at: '2026-05-04T15:00:00.000Z',
        original_occurred_at: '2026-05-04T15:35:00.000Z',
      },
      error: null,
    });
    mock.enqueue('clock_events', 'update', 'single', {
      data: { id: 'evt-1', occurred_at: '2026-05-04T14:55:00.000Z' },
      error: null,
    });

    await updateClockEventTime('evt-1', {
      occurredAt: '2026-05-04T14:55:00.000Z',
      editedBy: 'Jessica',
      editReason: 'Caregiver corrected by another minute',
    });

    const updateCall = mock.calls.find((c) => c.action === 'update');
    expect(updateCall.payload).not.toHaveProperty('original_occurred_at');
  });

  it('requires a non-empty reason', async () => {
    await expect(
      updateClockEventTime('evt-1', {
        occurredAt: '2026-05-04T15:00:00.000Z',
        editedBy: 'Jessica',
        editReason: '   ',
      }),
    ).rejects.toThrow(/reason is required/);
    expect(mock.calls.length).toBe(0);
  });

  it('requires id and occurredAt', async () => {
    await expect(
      updateClockEventTime(null, {
        occurredAt: '2026-05-04T15:00:00.000Z',
        editReason: 'x',
      }),
    ).rejects.toThrow(/Missing id/);
    await expect(
      updateClockEventTime('evt-1', { occurredAt: null, editReason: 'x' }),
    ).rejects.toThrow(/Missing id/);
    expect(mock.calls.length).toBe(0);
  });
});

// ─── getClockEventsForShift ────────────────────────────────────

describe('getClockEventsForShift', () => {
  it('filters by shift_id only when no caregiver scope is given', async () => {
    mock.enqueue('clock_events', 'select', 'noTerminal', { data: [], error: null });
    await getClockEventsForShift('shift-A');
    const select = mock.calls.find((c) => c.action === 'select');
    expect(select.filters).toEqual([{ col: 'shift_id', val: 'shift-A', op: 'eq' }]);
  });

  it('also filters by caregiver_id when given (so a reassigned shift does not mix prior caregivers\' punches)', async () => {
    mock.enqueue('clock_events', 'select', 'noTerminal', { data: [], error: null });
    await getClockEventsForShift('shift-A', { caregiverId: 'cg-9' });
    const select = mock.calls.find((c) => c.action === 'select');
    expect(select.filters).toEqual([
      { col: 'shift_id', val: 'shift-A', op: 'eq' },
      { col: 'caregiver_id', val: 'cg-9', op: 'eq' },
    ]);
  });

  it('returns [] without hitting the network when shiftId is missing', async () => {
    const out = await getClockEventsForShift(null);
    expect(out).toEqual([]);
    expect(mock.calls.length).toBe(0);
  });
});

// ─── deleteManualClockEvent ────────────────────────────────────

describe('deleteManualClockEvent', () => {
  it('issues a delete scoped to source=manual_entry', async () => {
    mock.enqueue('clock_events', 'delete', 'noTerminal', { error: null });

    const ok = await deleteManualClockEvent('evt-3');
    expect(ok).toBe(true);

    const del = mock.calls.find((c) => c.action === 'delete');
    expect(del).toBeTruthy();
  });

  it('rejects without an id', async () => {
    await expect(deleteManualClockEvent(null)).rejects.toThrow(/Missing/);
    expect(mock.calls.length).toBe(0);
  });
});

// ─── getClockEventsSummaryForShifts ────────────────────────────

describe('getClockEventsSummaryForShifts', () => {
  it('returns an empty Map without hitting the network for an empty list', async () => {
    const out = await getClockEventsSummaryForShifts([]);
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0);
    expect(mock.calls.length).toBe(0);
  });

  it('queries clock_events with shift_id IN (...) and reduces per shift', async () => {
    mock.enqueue('clock_events', 'select', 'noTerminal', {
      data: [
        // shift A: clean in/out
        { shift_id: 'A', event_type: 'in', occurred_at: '2026-05-04T15:00:00.000Z' },
        { shift_id: 'A', event_type: 'out', occurred_at: '2026-05-04T19:00:00.000Z' },
        // shift B: still clocked in
        { shift_id: 'B', event_type: 'in', occurred_at: '2026-05-04T15:00:00.000Z' },
        // shift C: in→out→in (later in reopens, actualEnd should be null)
        { shift_id: 'C', event_type: 'in', occurred_at: '2026-05-04T15:00:00.000Z' },
        { shift_id: 'C', event_type: 'out', occurred_at: '2026-05-04T17:00:00.000Z' },
        { shift_id: 'C', event_type: 'in', occurred_at: '2026-05-04T17:30:00.000Z' },
      ],
      error: null,
    });

    const out = await getClockEventsSummaryForShifts(['A', 'B', 'C']);

    expect(out.get('A')).toMatchObject({
      actualStart: '2026-05-04T15:00:00.000Z',
      actualEnd: '2026-05-04T19:00:00.000Z',
      isOpen: false,
      eventCount: 2,
    });
    expect(out.get('B')).toMatchObject({
      actualStart: '2026-05-04T15:00:00.000Z',
      actualEnd: null,
      isOpen: true,
    });
    expect(out.get('C')).toMatchObject({
      actualStart: '2026-05-04T15:00:00.000Z',
      actualEnd: null,
      isOpen: true,
    });

    const select = mock.calls.find((c) => c.action === 'select');
    expect(select.filters).toEqual([
      { col: 'shift_id', val: ['A', 'B', 'C'], op: 'in' },
    ]);
  });

  it('skips shifts that have no clock events', async () => {
    mock.enqueue('clock_events', 'select', 'noTerminal', {
      data: [
        { shift_id: 'A', event_type: 'in', occurred_at: '2026-05-04T15:00:00.000Z' },
      ],
      error: null,
    });

    const out = await getClockEventsSummaryForShifts(['A', 'B']);
    expect(out.has('A')).toBe(true);
    expect(out.has('B')).toBe(false);
  });
});
