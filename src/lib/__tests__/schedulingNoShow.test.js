import { describe, it, expect, beforeEach, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// markShiftNoShow tests.
//
// Thin wrapper around updateShift; the value of these tests is to
// pin the contract — that the wrapper sets status='no_show' and
// stamps marked_no_show_at / marked_no_show_by — so a future refactor
// of updateShift doesn't accidentally drop the audit fields.
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
      eq(col, val) { filters.push({ col, val }); return builder; },
      single() {
        calls.push({ table, action, terminal: 'single', payload, filters });
        return Promise.resolve(dequeue(table, action, 'single'));
      },
    };
    return builder;
  }

  const supabase = {
    from: vi.fn((table) => ({
      update: (payload) => makeBuilder(table, 'update', payload),
    })),
  };
  return { supabase, enqueue, calls };
}

let mock;

vi.mock('../supabase', () => ({
  supabase: new Proxy({}, { get: (_, prop) => mock.supabase[prop] }),
  isSupabaseConfigured: () => true,
}));

const { markShiftNoShow } = await import('../../features/scheduling/storage.js');

beforeEach(() => {
  mock = createSupabaseMock();
});

describe('markShiftNoShow', () => {
  it('updates status to no_show and stamps audit metadata', async () => {
    mock.enqueue('shifts', 'update', 'single', {
      data: {
        id: 'shift-1',
        status: 'no_show',
        no_show_note: 'Did not show, did not call',
        marked_no_show_at: '2026-05-04T16:00:00.000Z',
        marked_no_show_by: 'Jessica',
        created_at: '2026-04-30T00:00:00.000Z',
      },
      error: null,
    });

    const out = await markShiftNoShow('shift-1', {
      note: 'Did not show, did not call',
      markedBy: 'Jessica',
    });

    expect(out.status).toBe('no_show');
    expect(out.noShowNote).toBe('Did not show, did not call');
    expect(out.markedNoShowBy).toBe('Jessica');

    const update = mock.calls.find((c) => c.action === 'update');
    expect(update.payload.status).toBe('no_show');
    expect(update.payload.no_show_note).toBe('Did not show, did not call');
    expect(update.payload.marked_no_show_by).toBe('Jessica');
    expect(typeof update.payload.marked_no_show_at).toBe('string');
    // Sanity: not Number.isNaN of the timestamp
    expect(Number.isNaN(new Date(update.payload.marked_no_show_at).getTime())).toBe(false);
  });

  it('accepts a null note (the field is optional)', async () => {
    mock.enqueue('shifts', 'update', 'single', {
      data: { id: 'shift-1', status: 'no_show' },
      error: null,
    });

    await markShiftNoShow('shift-1', { note: null, markedBy: 'Jessica' });

    const update = mock.calls.find((c) => c.action === 'update');
    expect(update.payload.no_show_note).toBeNull();
    expect(update.payload.status).toBe('no_show');
  });
});
