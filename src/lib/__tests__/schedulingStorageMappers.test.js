import { describe, it, expect, vi } from 'vitest';
import {
  dbToServicePlan,
  servicePlanToDb,
  buildServicePlanPatchRow,
  dbToShift,
  shiftToDb,
  dbToAvailability,
  availabilityToDb,
  dbToAssignment,
  assignmentToDb,
  applyShiftWindowFilters,
} from '../../features/scheduling/storage';

// Chainable spy that records every method call as { method, args } so a
// test can assert the exact SQL-filter calls produced by a query builder.
const makeQuerySpy = () => {
  const calls = [];
  const handler = {
    get(_target, prop) {
      return (...args) => {
        calls.push({ method: prop, args });
        return new Proxy({}, handler);
      };
    },
  };
  const proxy = new Proxy({}, handler);
  return { query: proxy, calls };
};

// ─── service_plans ────────────────────────────────────────────────

describe('service plan mappers', () => {
  it('dbToServicePlan converts snake_case row to camelCase object', () => {
    const row = {
      id: 'plan-1',
      client_id: 'client-A',
      title: 'Weekly Companion',
      service_type: 'companion',
      hours_per_week: '20.00',
      preferred_times: { note: 'mornings' },
      recurrence_pattern: null,
      start_date: '2026-05-01',
      end_date: null,
      status: 'active',
      notes: 'VIP client',
      created_by: 'jessica',
      created_at: '2026-04-13T22:00:00.000Z',
      updated_at: '2026-04-13T22:00:00.000Z',
    };
    const plan = dbToServicePlan(row);
    expect(plan).toEqual({
      id: 'plan-1',
      clientId: 'client-A',
      title: 'Weekly Companion',
      serviceType: 'companion',
      hoursPerWeek: 20,
      preferredTimes: { note: 'mornings' },
      recurrencePattern: null,
      startDate: '2026-05-01',
      endDate: null,
      status: 'active',
      notes: 'VIP client',
      createdBy: 'jessica',
      createdAt: '2026-04-13T22:00:00.000Z',
      updatedAt: '2026-04-13T22:00:00.000Z',
    });
  });

  it('dbToServicePlan defaults status to draft when null', () => {
    const plan = dbToServicePlan({ id: 'x', client_id: 'c', status: null });
    expect(plan.status).toBe('draft');
  });

  it('dbToServicePlan returns null hoursPerWeek when not set', () => {
    const plan = dbToServicePlan({ id: 'x', client_id: 'c' });
    expect(plan.hoursPerWeek).toBeNull();
  });

  it('servicePlanToDb converts camelCase back to snake_case', () => {
    const plan = {
      id: 'plan-1',
      clientId: 'client-A',
      title: 'Weekly Companion',
      serviceType: 'companion',
      hoursPerWeek: 20,
      preferredTimes: { note: 'mornings' },
      startDate: '2026-05-01',
      endDate: null,
      status: 'active',
      notes: 'VIP client',
      createdBy: 'jessica',
    };
    const row = servicePlanToDb(plan);
    expect(row.client_id).toBe('client-A');
    expect(row.service_type).toBe('companion');
    expect(row.hours_per_week).toBe(20);
    expect(row.start_date).toBe('2026-05-01');
    expect(row.status).toBe('active');
    expect(row.updated_at).toBeTruthy();
  });

  it('servicePlanToDb provides default status = draft for new plans', () => {
    const row = servicePlanToDb({ clientId: 'c' });
    expect(row.status).toBe('draft');
  });
});

// ─── buildServicePlanPatchRow ─────────────────────────────────────
// Regression tests for the bug where a status-only update would
// also wipe title, notes, dates, hours, etc. This helper must only
// emit fields that are present in the patch.

describe('buildServicePlanPatchRow', () => {
  it('returns an empty-ish row (just updated_at) for an empty patch', () => {
    const row = buildServicePlanPatchRow({});
    expect(row.updated_at).toBeTruthy();
    expect(Object.keys(row)).toEqual(['updated_at']);
  });

  it('handles null or non-object patches without crashing', () => {
    expect(() => buildServicePlanPatchRow(null)).not.toThrow();
    expect(() => buildServicePlanPatchRow(undefined)).not.toThrow();
  });

  it('only emits the status field when patch is {status: "paused"}', () => {
    const row = buildServicePlanPatchRow({ status: 'paused' });
    expect(row.status).toBe('paused');
    expect(row.title).toBeUndefined();
    expect(row.notes).toBeUndefined();
    expect(row.start_date).toBeUndefined();
    expect(row.end_date).toBeUndefined();
    expect(row.hours_per_week).toBeUndefined();
    expect(row.service_type).toBeUndefined();
    expect(row.client_id).toBeUndefined();
  });

  it('emits multiple fields when multiple are present', () => {
    const row = buildServicePlanPatchRow({
      title: 'Renamed',
      status: 'active',
      hoursPerWeek: 30,
    });
    expect(row.title).toBe('Renamed');
    expect(row.status).toBe('active');
    expect(row.hours_per_week).toBe(30);
    expect(row.notes).toBeUndefined();
    expect(row.start_date).toBeUndefined();
  });

  it('preserves explicit null values in the patch', () => {
    const row = buildServicePlanPatchRow({ endDate: null });
    expect(row.end_date).toBeNull();
    // Only end_date and updated_at should be set
    expect(Object.keys(row).sort()).toEqual(['end_date', 'updated_at']);
  });

  it('always stamps updated_at', () => {
    const row = buildServicePlanPatchRow({ status: 'ended' });
    const stamp = new Date(row.updated_at);
    expect(Number.isNaN(stamp.getTime())).toBe(false);
  });
});

// ─── shifts ────────────────────────────────────────────────────

describe('shift mappers', () => {
  const fullRow = {
    id: 'shift-1',
    service_plan_id: 'plan-1',
    client_id: 'client-A',
    assigned_caregiver_id: 'cg-maria',
    start_time: '2026-05-04T08:00:00.000Z',
    end_time: '2026-05-04T12:00:00.000Z',
    status: 'confirmed',
    recurrence_group_id: null,
    recurrence_rule: null,
    location_address: '123 Main St',
    hourly_rate: '24.50',
    billable_rate: '35.00',
    mileage: '12.50',
    required_skills: ['Hoyer lift', 'dementia care'],
    instructions: 'Help with morning routine',
    notes: 'Client prefers tea over coffee',
    cancel_reason: null,
    cancelled_at: null,
    cancelled_by: null,
    created_by: 'jessica',
    created_at: '2026-04-13T22:00:00.000Z',
    updated_at: '2026-04-13T22:00:00.000Z',
  };

  it('dbToShift maps all fields and coerces rates to numbers', () => {
    const shift = dbToShift(fullRow);
    expect(shift.id).toBe('shift-1');
    expect(shift.servicePlanId).toBe('plan-1');
    expect(shift.assignedCaregiverId).toBe('cg-maria');
    expect(shift.hourlyRate).toBe(24.5);
    expect(shift.billableRate).toBe(35);
    expect(shift.mileage).toBe(12.5);
    expect(shift.requiredSkills).toEqual(['Hoyer lift', 'dementia care']);
    expect(shift.status).toBe('confirmed');
  });

  it('dbToShift handles null rate fields', () => {
    const shift = dbToShift({
      ...fullRow,
      hourly_rate: null,
      billable_rate: null,
      mileage: null,
    });
    expect(shift.hourlyRate).toBeNull();
    expect(shift.billableRate).toBeNull();
    expect(shift.mileage).toBeNull();
  });

  it('dbToShift defaults status to open when null', () => {
    const shift = dbToShift({ ...fullRow, status: null });
    expect(shift.status).toBe('open');
  });

  it('dbToShift returns empty array for missing required_skills', () => {
    const shift = dbToShift({ ...fullRow, required_skills: null });
    expect(shift.requiredSkills).toEqual([]);
  });

  it('shiftToDb maps camelCase back with nulls for missing fields', () => {
    const shift = {
      clientId: 'client-A',
      startTime: '2026-05-04T08:00:00.000Z',
      endTime: '2026-05-04T12:00:00.000Z',
      hourlyRate: 24.5,
    };
    const row = shiftToDb(shift);
    expect(row.client_id).toBe('client-A');
    expect(row.hourly_rate).toBe(24.5);
    expect(row.assigned_caregiver_id).toBeNull();
    expect(row.service_plan_id).toBeNull();
    expect(row.status).toBe('open');
    expect(row.required_skills).toEqual([]);
  });
});

// ─── caregiver_availability ────────────────────────────────────

describe('availability mappers', () => {
  it('dbToAvailability preserves all fields with camelCase keys', () => {
    const row = {
      id: 'av-1',
      caregiver_id: 'cg-maria',
      type: 'available',
      day_of_week: 1,
      start_time: '08:00:00',
      end_time: '16:00:00',
      start_date: null,
      end_date: null,
      effective_from: '2026-05-01',
      effective_until: null,
      reason: null,
      notes: null,
      created_by: 'jessica',
      created_at: '2026-04-13T22:00:00.000Z',
      updated_at: '2026-04-13T22:00:00.000Z',
    };
    const av = dbToAvailability(row);
    expect(av.caregiverId).toBe('cg-maria');
    expect(av.type).toBe('available');
    expect(av.dayOfWeek).toBe(1);
    expect(av.startTime).toBe('08:00:00');
    expect(av.endTime).toBe('16:00:00');
    expect(av.effectiveFrom).toBe('2026-05-01');
  });

  it('availabilityToDb sets sensible defaults for new rows', () => {
    const row = availabilityToDb({
      caregiverId: 'cg-maria',
      dayOfWeek: 1,
      startTime: '08:00',
      endTime: '16:00',
    });
    expect(row.caregiver_id).toBe('cg-maria');
    expect(row.type).toBe('available');
    expect(row.day_of_week).toBe(1);
    expect(row.start_time).toBe('08:00');
    expect(row.end_time).toBe('16:00');
    expect(row.start_date).toBeNull();
    expect(row.updated_at).toBeTruthy();
  });
});

// ─── caregiver_assignments ─────────────────────────────────────

describe('assignment mappers', () => {
  it('dbToAssignment converts snake_case correctly', () => {
    const row = {
      id: 'a-1',
      caregiver_id: 'cg-maria',
      client_id: 'client-A',
      service_plan_id: 'plan-1',
      role: 'primary',
      status: 'active',
      started_at: '2026-05-01T00:00:00.000Z',
      ended_at: null,
      end_reason: null,
      notes: null,
      created_by: 'jessica',
      created_at: '2026-04-13T22:00:00.000Z',
      updated_at: '2026-04-13T22:00:00.000Z',
    };
    const a = dbToAssignment(row);
    expect(a.caregiverId).toBe('cg-maria');
    expect(a.clientId).toBe('client-A');
    expect(a.role).toBe('primary');
    expect(a.status).toBe('active');
  });

  it('dbToAssignment defaults role and status', () => {
    const a = dbToAssignment({
      id: 'a-1',
      caregiver_id: 'cg-maria',
      client_id: 'client-A',
      role: null,
      status: null,
    });
    expect(a.role).toBe('primary');
    expect(a.status).toBe('active');
  });

  it('assignmentToDb accepts all valid roles', () => {
    for (const role of ['primary', 'backup', 'float']) {
      const row = assignmentToDb({
        caregiverId: 'cg',
        clientId: 'cl',
        role,
      });
      expect(row.role).toBe(role);
    }
  });
});

// ─── applyShiftWindowFilters (calendar overlap semantics) ──────
// Regression guard for the bug where both bounds were applied to
// start_time, causing overnight and long-running shifts that began
// before the visible window to be silently dropped.

describe('applyShiftWindowFilters', () => {
  it('filters end_time >= startDate so shifts ending inside the window are included', () => {
    const { query, calls } = makeQuerySpy();
    applyShiftWindowFilters(query, { startDate: '2026-05-04T00:00:00.000Z' });
    expect(calls).toEqual([
      { method: 'gte', args: ['end_time', '2026-05-04T00:00:00.000Z'] },
    ]);
  });

  it('filters start_time <= endDate so shifts starting inside the window are included', () => {
    const { query, calls } = makeQuerySpy();
    applyShiftWindowFilters(query, { endDate: '2026-05-11T00:00:00.000Z' });
    expect(calls).toEqual([
      { method: 'lte', args: ['start_time', '2026-05-11T00:00:00.000Z'] },
    ]);
  });

  it('applies both bounds for a full overlap query', () => {
    const { query, calls } = makeQuerySpy();
    applyShiftWindowFilters(query, {
      startDate: '2026-05-04T00:00:00.000Z',
      endDate: '2026-05-11T00:00:00.000Z',
    });
    expect(calls).toEqual([
      { method: 'gte', args: ['end_time', '2026-05-04T00:00:00.000Z'] },
      { method: 'lte', args: ['start_time', '2026-05-11T00:00:00.000Z'] },
    ]);
  });

  it('is a no-op when neither bound is set', () => {
    const { query, calls } = makeQuerySpy();
    applyShiftWindowFilters(query, {});
    expect(calls).toEqual([]);
  });

  it('does NOT bound end_time by endDate (would drop in-progress long shifts)', () => {
    const { calls } = (() => {
      const spy = makeQuerySpy();
      applyShiftWindowFilters(spy.query, {
        startDate: '2026-05-04T00:00:00.000Z',
        endDate: '2026-05-11T00:00:00.000Z',
      });
      return spy;
    })();
    // Defense-in-depth: make sure nobody adds a spurious end_time upper bound.
    const endTimeUpperBound = calls.find(
      (c) => c.method === 'lte' && c.args[0] === 'end_time',
    );
    expect(endTimeUpperBound).toBeUndefined();
  });

  it('documented overlap rule: a shift overlaps [start, end] iff start_time <= end AND end_time >= start', () => {
    // This test pins the semantic contract so a future refactor doesn't
    // accidentally revert to the buggy same-column-on-both-bounds form.
    const windowStart = new Date('2026-05-04T00:00:00.000Z').getTime();
    const windowEnd = new Date('2026-05-11T00:00:00.000Z').getTime();

    const cases = [
      // Overnight shift crossing window start: prev-buggy version dropped this.
      { start: '2026-05-03T22:00:00.000Z', end: '2026-05-04T06:00:00.000Z', overlaps: true },
      // Long shift fully spanning the window.
      { start: '2026-05-01T00:00:00.000Z', end: '2026-06-01T00:00:00.000Z', overlaps: true },
      // Shift entirely inside the window.
      { start: '2026-05-06T08:00:00.000Z', end: '2026-05-06T16:00:00.000Z', overlaps: true },
      // Shift entirely before the window.
      { start: '2026-05-01T08:00:00.000Z', end: '2026-05-01T16:00:00.000Z', overlaps: false },
      // Shift entirely after the window.
      { start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T16:00:00.000Z', overlaps: false },
    ];
    for (const c of cases) {
      const s = new Date(c.start).getTime();
      const e = new Date(c.end).getTime();
      const overlapsByRule = s <= windowEnd && e >= windowStart;
      expect(overlapsByRule).toBe(c.overlaps);
    }
  });
});
