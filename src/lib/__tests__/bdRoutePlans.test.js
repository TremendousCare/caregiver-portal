import { describe, it, expect } from 'vitest';
import {
  todayLocalIsoDate,
  normalizeStops,
  planHasStop,
  addStopToPlan,
  removeStopFromPlan,
  moveStop,
  pruneStopsAgainstAccounts,
  hydrateStops,
  fetchActiveRoutePlan,
  createRoutePlan,
  updateRoutePlanStops,
  archiveRoutePlan,
} from '../../features/bd-portal/lib/bdRoutePlans';

const ACC = (id, extra = {}) => ({ id, name: `Account ${id}`, city: 'Mission Viejo', ...extra });

// ─── Date helpers ─────────────────────────────────────────────────

describe('todayLocalIsoDate', () => {
  it('formats a Date as YYYY-MM-DD using local fields (not UTC)', () => {
    // 2026-05-13 23:30 in a +08:00 timezone is 2026-05-13 in local
    // time but 2026-05-13 15:30 in UTC. We assert via local fields
    // by constructing the Date with local-time year/month/day.
    const d = new Date(2026, 4, 13, 23, 30);
    expect(todayLocalIsoDate(d)).toBe('2026-05-13');
  });

  it('zero-pads month and day', () => {
    const d = new Date(2026, 0, 3, 9, 0);
    expect(todayLocalIsoDate(d)).toBe('2026-01-03');
  });

  it('defaults to the current Date when called with no args', () => {
    const r = todayLocalIsoDate();
    expect(r).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── Stops shape ──────────────────────────────────────────────────

describe('normalizeStops', () => {
  it('returns an empty array for null/undefined/non-array input', () => {
    expect(normalizeStops(null)).toEqual([]);
    expect(normalizeStops(undefined)).toEqual([]);
    expect(normalizeStops('not an array')).toEqual([]);
    expect(normalizeStops({})).toEqual([]);
  });

  it('renumbers positions to be contiguous starting at zero', () => {
    const input = [
      { account_id: 'a', position: 7 },
      { account_id: 'b', position: 99 },
      { account_id: 'c', position: 0 },
    ];
    const out = normalizeStops(input);
    expect(out).toEqual([
      { account_id: 'a', position: 0 },
      { account_id: 'b', position: 1 },
      { account_id: 'c', position: 2 },
    ]);
  });

  it('drops malformed entries (missing account_id, non-string id, null, primitives)', () => {
    const input = [
      { account_id: 'good' },
      null,
      'string',
      { foo: 'bar' },
      { account_id: '' },
      { account_id: 42 },
      { account_id: 'good2' },
    ];
    const out = normalizeStops(input);
    expect(out.map((s) => s.account_id)).toEqual(['good', 'good2']);
  });
});

describe('planHasStop', () => {
  it('returns true when the account is in the stops list', () => {
    expect(planHasStop([{ account_id: 'a' }, { account_id: 'b' }], 'b')).toBe(true);
  });
  it('returns false when missing', () => {
    expect(planHasStop([{ account_id: 'a' }], 'b')).toBe(false);
  });
  it('returns false for empty / null stops', () => {
    expect(planHasStop([], 'b')).toBe(false);
    expect(planHasStop(null, 'b')).toBe(false);
  });
});

describe('addStopToPlan', () => {
  it('appends a stop with the next position', () => {
    const stops = [{ account_id: 'a', position: 0 }];
    expect(addStopToPlan(stops, 'b')).toEqual([
      { account_id: 'a', position: 0 },
      { account_id: 'b', position: 1 },
    ]);
  });

  it('is a no-op when the account is already in the plan', () => {
    const stops = [{ account_id: 'a', position: 0 }, { account_id: 'b', position: 1 }];
    expect(addStopToPlan(stops, 'b')).toEqual(stops);
  });

  it('is a no-op for null/empty account id', () => {
    const stops = [{ account_id: 'a', position: 0 }];
    expect(addStopToPlan(stops, null)).toEqual(stops);
    expect(addStopToPlan(stops, '')).toEqual(stops);
  });

  it('renumbers positions when starting from a malformed input', () => {
    const stops = [{ account_id: 'a', position: 99 }];
    expect(addStopToPlan(stops, 'b')).toEqual([
      { account_id: 'a', position: 0 },
      { account_id: 'b', position: 1 },
    ]);
  });
});

describe('removeStopFromPlan', () => {
  it('removes the matching stop and renumbers', () => {
    const stops = [
      { account_id: 'a', position: 0 },
      { account_id: 'b', position: 1 },
      { account_id: 'c', position: 2 },
    ];
    expect(removeStopFromPlan(stops, 'b')).toEqual([
      { account_id: 'a', position: 0 },
      { account_id: 'c', position: 1 },
    ]);
  });

  it('is a no-op when the account is not in the plan', () => {
    const stops = [{ account_id: 'a', position: 0 }];
    expect(removeStopFromPlan(stops, 'zzz')).toEqual([{ account_id: 'a', position: 0 }]);
  });
});

describe('moveStop', () => {
  const base = () => [
    { account_id: 'a', position: 0 },
    { account_id: 'b', position: 1 },
    { account_id: 'c', position: 2 },
  ];

  it('moves the stop earlier (direction -1)', () => {
    expect(moveStop(base(), 'b', -1).map((s) => s.account_id)).toEqual(['b', 'a', 'c']);
  });

  it('moves the stop later (direction +1)', () => {
    expect(moveStop(base(), 'b', +1).map((s) => s.account_id)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op when moving the first stop earlier (out of bounds)', () => {
    expect(moveStop(base(), 'a', -1).map((s) => s.account_id)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op when moving the last stop later (out of bounds)', () => {
    expect(moveStop(base(), 'c', +1).map((s) => s.account_id)).toEqual(['a', 'b', 'c']);
  });

  it('renumbers positions after the move', () => {
    const out = moveStop(base(), 'b', -1);
    expect(out).toEqual([
      { account_id: 'b', position: 0 },
      { account_id: 'a', position: 1 },
      { account_id: 'c', position: 2 },
    ]);
  });

  it('is a no-op for an unknown account id', () => {
    expect(moveStop(base(), 'zzz', +1).map((s) => s.account_id)).toEqual(['a', 'b', 'c']);
  });
});

describe('pruneStopsAgainstAccounts', () => {
  it('drops stops referencing accounts that no longer exist', () => {
    const stops = [
      { account_id: 'a', position: 0 },
      { account_id: 'gone', position: 1 },
      { account_id: 'b', position: 2 },
    ];
    const { stops: kept, dropped } = pruneStopsAgainstAccounts(stops, [ACC('a'), ACC('b')]);
    expect(kept.map((s) => s.account_id)).toEqual(['a', 'b']);
    expect(dropped).toBe(1);
  });

  it('returns the input as-is (renormalized) when every stop has a live account', () => {
    const stops = [{ account_id: 'a', position: 0 }, { account_id: 'b', position: 1 }];
    const { stops: kept, dropped } = pruneStopsAgainstAccounts(stops, [ACC('a'), ACC('b')]);
    expect(kept).toEqual(stops);
    expect(dropped).toBe(0);
  });

  it('returns the normalized list (dropped=0) when accounts list is empty (defensive — we cannot prune without it)', () => {
    const stops = [{ account_id: 'a', position: 0 }];
    const { stops: kept, dropped } = pruneStopsAgainstAccounts(stops, []);
    expect(kept).toEqual([{ account_id: 'a', position: 0 }]);
    expect(dropped).toBe(0);
  });
});

describe('hydrateStops', () => {
  it('joins each stop to its account in route order', () => {
    const stops = [{ account_id: 'b', position: 0 }, { account_id: 'a', position: 1 }];
    const out = hydrateStops(stops, [ACC('a'), ACC('b')]);
    expect(out.map((h) => h.account.id)).toEqual(['b', 'a']);
    expect(out[0].position).toBe(0);
  });

  it('skips stops whose account is missing', () => {
    const stops = [{ account_id: 'a', position: 0 }, { account_id: 'gone', position: 1 }];
    const out = hydrateStops(stops, [ACC('a')]);
    expect(out).toHaveLength(1);
    expect(out[0].account.id).toBe('a');
  });

  it('returns [] when accounts is empty', () => {
    expect(hydrateStops([{ account_id: 'a', position: 0 }], [])).toEqual([]);
  });
});

// ─── Supabase fetchers (stubbed) ──────────────────────────────────

function stubSupabase(handler) {
  // Replays the supabase-js builder chain. Each .eq/.select/etc returns
  // `this` so the call sequence composes. The terminal awaitable
  // resolves to whatever `handler` returns based on the operation.
  const state = { operation: null, table: null, payload: null, filters: {} };
  const chain = {
    from(table) { state.table = table; state.operation = null; state.payload = null; state.filters = {}; return chain; },
    select() { return chain; },
    insert(p) { state.operation = 'insert'; state.payload = p; return chain; },
    update(p) { state.operation = 'update'; state.payload = p; return chain; },
    eq(k, v) { state.filters[k] = v; return chain; },
    maybeSingle() { return Promise.resolve(handler({ ...state, terminal: 'maybeSingle' })); },
    single() { return Promise.resolve(handler({ ...state, terminal: 'single' })); },
    then(resolve, reject) { return Promise.resolve(handler({ ...state, terminal: 'then' })).then(resolve, reject); },
  };
  return chain;
}

describe('fetchActiveRoutePlan', () => {
  it('returns { data: null } when no plan exists (maybeSingle)', async () => {
    const supabase = stubSupabase(() => ({ data: null, error: null }));
    const res = await fetchActiveRoutePlan(supabase, 'user-1', '2026-05-13');
    expect(res).toEqual({ data: null, error: null });
  });

  it('returns the plan row when one exists', async () => {
    const supabase = stubSupabase(({ filters }) => {
      expect(filters.owner_user_id).toBe('user-1');
      expect(filters.plan_date).toBe('2026-05-13');
      expect(filters.status).toBe('active');
      return { data: { id: 'plan-1', stops: [] }, error: null };
    });
    const res = await fetchActiveRoutePlan(supabase, 'user-1', '2026-05-13');
    expect(res.data).toEqual({ id: 'plan-1', stops: [] });
  });

  it('returns { data: null, error: null } for missing args', async () => {
    expect(await fetchActiveRoutePlan(null, 'u', 'd')).toEqual({ data: null, error: null });
    expect(await fetchActiveRoutePlan({}, null, 'd')).toEqual({ data: null, error: null });
    expect(await fetchActiveRoutePlan({}, 'u', null)).toEqual({ data: null, error: null });
  });
});

describe('createRoutePlan', () => {
  it('inserts a row with normalized stops and returns it', async () => {
    let capturedPayload = null;
    const supabase = stubSupabase(({ operation, payload }) => {
      expect(operation).toBe('insert');
      capturedPayload = payload;
      return { data: { id: 'plan-new', stops: payload.stops }, error: null };
    });
    const res = await createRoutePlan(supabase, 'user-1', '2026-05-13', {
      stops: [{ account_id: 'a', position: 9 }],
    });
    expect(res.data.id).toBe('plan-new');
    expect(capturedPayload.owner_user_id).toBe('user-1');
    expect(capturedPayload.plan_date).toBe('2026-05-13');
    expect(capturedPayload.status).toBe('active');
    // Position renumbered by normalize.
    expect(capturedPayload.stops).toEqual([{ account_id: 'a', position: 0 }]);
  });

  it('returns an error for missing args without hitting Supabase', async () => {
    const res = await createRoutePlan(null, 'u', 'd');
    expect(res.data).toBe(null);
    expect(res.error).toBeInstanceOf(Error);
  });
});

describe('updateRoutePlanStops', () => {
  it('writes the normalized stops array to the named plan', async () => {
    let capturedPayload = null;
    const supabase = stubSupabase(({ operation, payload, filters }) => {
      expect(operation).toBe('update');
      expect(filters.id).toBe('plan-1');
      capturedPayload = payload;
      return { data: { id: 'plan-1', stops: payload.stops }, error: null };
    });
    const res = await updateRoutePlanStops(supabase, 'plan-1', [
      { account_id: 'a', position: 0 },
      { account_id: 'b', position: 1 },
    ]);
    expect(res.data.id).toBe('plan-1');
    expect(capturedPayload.stops).toEqual([
      { account_id: 'a', position: 0 },
      { account_id: 'b', position: 1 },
    ]);
  });

  it('returns an error for missing args', async () => {
    const res = await updateRoutePlanStops(null, 'plan-1', []);
    expect(res.error).toBeInstanceOf(Error);
  });
});

describe('archiveRoutePlan', () => {
  it("updates status='archived' on the named plan", async () => {
    let capturedPayload = null;
    const supabase = stubSupabase(({ operation, payload, filters }) => {
      expect(operation).toBe('update');
      expect(filters.id).toBe('plan-1');
      capturedPayload = payload;
      return { data: { id: 'plan-1', status: 'archived' }, error: null };
    });
    const res = await archiveRoutePlan(supabase, 'plan-1');
    expect(res.data.status).toBe('archived');
    expect(capturedPayload).toEqual({ status: 'archived' });
  });
});
