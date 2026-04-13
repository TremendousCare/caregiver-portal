import { describe, it, expect } from 'vitest';
import {
  dbToCarePlan,
  carePlanToDb,
  buildCarePlanPatchRow,
  dbToShift,
  shiftToDb,
  dbToAvailability,
  availabilityToDb,
  dbToAssignment,
  assignmentToDb,
} from '../../features/scheduling/storage';

// ─── care_plans ────────────────────────────────────────────────

describe('care plan mappers', () => {
  it('dbToCarePlan converts snake_case row to camelCase object', () => {
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
    const plan = dbToCarePlan(row);
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

  it('dbToCarePlan defaults status to draft when null', () => {
    const plan = dbToCarePlan({ id: 'x', client_id: 'c', status: null });
    expect(plan.status).toBe('draft');
  });

  it('dbToCarePlan returns null hoursPerWeek when not set', () => {
    const plan = dbToCarePlan({ id: 'x', client_id: 'c' });
    expect(plan.hoursPerWeek).toBeNull();
  });

  it('carePlanToDb converts camelCase back to snake_case', () => {
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
    const row = carePlanToDb(plan);
    expect(row.client_id).toBe('client-A');
    expect(row.service_type).toBe('companion');
    expect(row.hours_per_week).toBe(20);
    expect(row.start_date).toBe('2026-05-01');
    expect(row.status).toBe('active');
    expect(row.updated_at).toBeTruthy();
  });

  it('carePlanToDb provides default status = draft for new plans', () => {
    const row = carePlanToDb({ clientId: 'c' });
    expect(row.status).toBe('draft');
  });
});

// ─── buildCarePlanPatchRow ─────────────────────────────────────
// Regression tests for the bug where a status-only update would
// also wipe title, notes, dates, hours, etc. This helper must only
// emit fields that are present in the patch.

describe('buildCarePlanPatchRow', () => {
  it('returns an empty-ish row (just updated_at) for an empty patch', () => {
    const row = buildCarePlanPatchRow({});
    expect(row.updated_at).toBeTruthy();
    expect(Object.keys(row)).toEqual(['updated_at']);
  });

  it('handles null or non-object patches without crashing', () => {
    expect(() => buildCarePlanPatchRow(null)).not.toThrow();
    expect(() => buildCarePlanPatchRow(undefined)).not.toThrow();
  });

  it('only emits the status field when patch is {status: "paused"}', () => {
    const row = buildCarePlanPatchRow({ status: 'paused' });
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
    const row = buildCarePlanPatchRow({
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
    const row = buildCarePlanPatchRow({ endDate: null });
    expect(row.end_date).toBeNull();
    // Only end_date and updated_at should be set
    expect(Object.keys(row).sort()).toEqual(['end_date', 'updated_at']);
  });

  it('always stamps updated_at', () => {
    const row = buildCarePlanPatchRow({ status: 'ended' });
    const stamp = new Date(row.updated_at);
    expect(Number.isNaN(stamp.getTime())).toBe(false);
  });
});

// ─── shifts ────────────────────────────────────────────────────

describe('shift mappers', () => {
  const fullRow = {
    id: 'shift-1',
    care_plan_id: 'plan-1',
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
    expect(shift.carePlanId).toBe('plan-1');
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
    expect(row.care_plan_id).toBeNull();
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
      care_plan_id: 'plan-1',
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
