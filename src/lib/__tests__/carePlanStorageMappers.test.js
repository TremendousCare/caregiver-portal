import { describe, it, expect } from 'vitest';
import {
  dbToCarePlan,
  carePlanToDb,
  dbToCarePlanVersion,
  carePlanVersionToDb,
  dbToCarePlanTask,
  carePlanTaskToDb,
} from '../../features/care-plans/storage';

// ─── care_plans mappers ─────────────────────────────────────────

describe('dbToCarePlan / carePlanToDb', () => {
  it('dbToCarePlan converts snake_case row to camelCase object', () => {
    const row = {
      id: 'plan-1',
      client_id: 'client-A',
      status: 'active',
      current_version_id: 'v-uuid-1',
      created_by: 'jessica',
      created_at: '2026-04-18T20:00:00.000Z',
      updated_at: '2026-04-18T20:00:00.000Z',
    };
    expect(dbToCarePlan(row)).toEqual({
      id: 'plan-1',
      clientId: 'client-A',
      status: 'active',
      currentVersionId: 'v-uuid-1',
      createdBy: 'jessica',
      createdAt: '2026-04-18T20:00:00.000Z',
      updatedAt: '2026-04-18T20:00:00.000Z',
    });
  });

  it('dbToCarePlan defaults status to active when null', () => {
    const plan = dbToCarePlan({
      id: 'p',
      client_id: 'c',
      status: null,
    });
    expect(plan.status).toBe('active');
  });

  it('dbToCarePlan treats missing current_version_id as null', () => {
    const plan = dbToCarePlan({ id: 'p', client_id: 'c' });
    expect(plan.currentVersionId).toBeNull();
  });

  it('dbToCarePlan returns null for null input', () => {
    expect(dbToCarePlan(null)).toBeNull();
    expect(dbToCarePlan(undefined)).toBeNull();
  });

  it('carePlanToDb converts camelCase back to snake_case', () => {
    const row = carePlanToDb({
      id: 'plan-1',
      clientId: 'client-A',
      status: 'active',
      currentVersionId: 'v-uuid-1',
      createdBy: 'jessica',
    });
    expect(row).toEqual({
      id: 'plan-1',
      client_id: 'client-A',
      status: 'active',
      current_version_id: 'v-uuid-1',
      created_by: 'jessica',
    });
  });

  it('carePlanToDb defaults status to active for new plans', () => {
    const row = carePlanToDb({ clientId: 'c' });
    expect(row.status).toBe('active');
  });
});

// ─── care_plan_versions mappers ────────────────────────────────

describe('dbToCarePlanVersion / carePlanVersionToDb', () => {
  const fullRow = {
    id: 'v-1',
    care_plan_id: 'plan-1',
    version_number: 2,
    status: 'published',
    version_reason: 'post-hospitalization',
    created_by: 'jessica',
    created_at: '2026-04-18T20:00:00.000Z',
    updated_at: '2026-04-18T20:15:00.000Z',
    published_at: '2026-04-18T20:15:00.000Z',
    published_by: 'jessica',
    client_signed_name: 'Jane Doe',
    client_signed_at: '2026-04-18T20:14:30.000Z',
    agency_signed_name: 'Jessica Lee',
    agency_signed_at: '2026-04-18T20:14:45.000Z',
    data: {
      demographics: { narrative: 'Prefers quiet mornings' },
      medicalProfile: { narrative: 'HTN, CHF, osteoarthritis' },
    },
    generated_summary: 'Mr. Smith is an 82-year-old...',
  };

  it('dbToCarePlanVersion preserves every field with camelCase keys', () => {
    const v = dbToCarePlanVersion(fullRow);
    expect(v.id).toBe('v-1');
    expect(v.carePlanId).toBe('plan-1');
    expect(v.versionNumber).toBe(2);
    expect(v.status).toBe('published');
    expect(v.versionReason).toBe('post-hospitalization');
    expect(v.publishedAt).toBe('2026-04-18T20:15:00.000Z');
    expect(v.clientSignedName).toBe('Jane Doe');
    expect(v.agencySignedName).toBe('Jessica Lee');
    expect(v.data.demographics.narrative).toBe('Prefers quiet mornings');
    expect(v.generatedSummary).toMatch(/Mr. Smith/);
  });

  it('dbToCarePlanVersion defaults status to draft when null', () => {
    const v = dbToCarePlanVersion({ ...fullRow, status: null });
    expect(v.status).toBe('draft');
  });

  it('dbToCarePlanVersion defaults data to an empty object when null', () => {
    const v = dbToCarePlanVersion({ ...fullRow, data: null });
    expect(v.data).toEqual({});
  });

  it('dbToCarePlanVersion returns null for null input', () => {
    expect(dbToCarePlanVersion(null)).toBeNull();
  });

  it('carePlanVersionToDb serializes the core fields', () => {
    const row = carePlanVersionToDb({
      id: 'v-1',
      carePlanId: 'plan-1',
      versionNumber: 2,
      status: 'draft',
      versionReason: 'quarterly review',
      createdBy: 'jessica',
      data: { demographics: { narrative: 'note' } },
    });
    expect(row.care_plan_id).toBe('plan-1');
    expect(row.version_number).toBe(2);
    expect(row.status).toBe('draft');
    expect(row.version_reason).toBe('quarterly review');
    expect(row.data.demographics.narrative).toBe('note');
  });

  it('carePlanVersionToDb defaults status to draft', () => {
    const row = carePlanVersionToDb({
      carePlanId: 'p',
      versionNumber: 1,
    });
    expect(row.status).toBe('draft');
    expect(row.data).toEqual({});
  });
});

// ─── care_plan_tasks mappers ───────────────────────────────────

describe('dbToCarePlanTask / carePlanTaskToDb', () => {
  const fullRow = {
    id: 't-1',
    version_id: 'v-1',
    category: 'adl.bathing',
    task_name: 'Assist into and out of shower',
    description: 'Stand-by with gait belt. Shower chair in bathroom.',
    shifts: ['morning'],
    days_of_week: [1, 3, 5],
    priority: 'critical',
    safety_notes: 'Fall risk. Never leave unattended in tub.',
    sort_order: 10,
    created_at: '2026-04-18T20:00:00.000Z',
    updated_at: '2026-04-18T20:00:00.000Z',
  };

  it('dbToCarePlanTask converts all fields to camelCase', () => {
    const task = dbToCarePlanTask(fullRow);
    expect(task.id).toBe('t-1');
    expect(task.versionId).toBe('v-1');
    expect(task.category).toBe('adl.bathing');
    expect(task.taskName).toMatch(/shower/);
    expect(task.shifts).toEqual(['morning']);
    expect(task.daysOfWeek).toEqual([1, 3, 5]);
    expect(task.priority).toBe('critical');
    expect(task.sortOrder).toBe(10);
  });

  it('dbToCarePlanTask defaults shifts to ["all"] when null', () => {
    const task = dbToCarePlanTask({ ...fullRow, shifts: null });
    expect(task.shifts).toEqual(['all']);
  });

  it('dbToCarePlanTask defaults days_of_week to [] when null', () => {
    const task = dbToCarePlanTask({ ...fullRow, days_of_week: null });
    expect(task.daysOfWeek).toEqual([]);
  });

  it('dbToCarePlanTask defaults priority to standard when null', () => {
    const task = dbToCarePlanTask({ ...fullRow, priority: null });
    expect(task.priority).toBe('standard');
  });

  it('dbToCarePlanTask defaults sort_order to 0 when null', () => {
    const task = dbToCarePlanTask({ ...fullRow, sort_order: null });
    expect(task.sortOrder).toBe(0);
  });

  it('dbToCarePlanTask returns null for null input', () => {
    expect(dbToCarePlanTask(null)).toBeNull();
  });

  it('carePlanTaskToDb forces shifts to ["all"] when missing or empty', () => {
    expect(
      carePlanTaskToDb({
        versionId: 'v',
        category: 'adl.bathing',
        taskName: 't',
      }).shifts,
    ).toEqual(['all']);

    expect(
      carePlanTaskToDb({
        versionId: 'v',
        category: 'adl.bathing',
        taskName: 't',
        shifts: [],
      }).shifts,
    ).toEqual(['all']);
  });

  it('carePlanTaskToDb preserves explicit shift arrays', () => {
    expect(
      carePlanTaskToDb({
        versionId: 'v',
        category: 'adl.bathing',
        taskName: 't',
        shifts: ['morning', 'evening'],
      }).shifts,
    ).toEqual(['morning', 'evening']);
  });

  it('carePlanTaskToDb defaults days_of_week to [] when missing', () => {
    expect(
      carePlanTaskToDb({
        versionId: 'v',
        category: 'adl.bathing',
        taskName: 't',
      }).days_of_week,
    ).toEqual([]);
  });

  it('carePlanTaskToDb defaults priority and sort_order', () => {
    const row = carePlanTaskToDb({
      versionId: 'v',
      category: 'adl.bathing',
      taskName: 't',
    });
    expect(row.priority).toBe('standard');
    expect(row.sort_order).toBe(0);
  });
});

// ─── Mapper round-trips ────────────────────────────────────────

describe('round-trip safety', () => {
  it('carePlan round-trips through db and back', () => {
    const plan = {
      id: 'p',
      clientId: 'c',
      status: 'active',
      currentVersionId: 'v',
      createdBy: 'jessica',
      createdAt: '2026-04-18T20:00:00.000Z',
      updatedAt: '2026-04-18T20:00:00.000Z',
    };
    // Round-trip: db-shape, then back to app-shape. Timestamps don't
    // survive because they're only set on write, not in carePlanToDb.
    const row = { ...carePlanToDb(plan), created_at: plan.createdAt, updated_at: plan.updatedAt };
    expect(dbToCarePlan(row)).toEqual(plan);
  });

  it('task round-trips through db and back', () => {
    const task = {
      id: 't',
      versionId: 'v',
      category: 'iadl.housework',
      taskName: 'Change bed linens',
      description: 'Once per week',
      shifts: ['morning'],
      daysOfWeek: [1],
      priority: 'standard',
      safetyNotes: null,
      sortOrder: 3,
      createdAt: '2026-04-18T20:00:00.000Z',
      updatedAt: '2026-04-18T20:00:00.000Z',
    };
    const row = {
      ...carePlanTaskToDb(task),
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    };
    expect(dbToCarePlanTask(row)).toEqual(task);
  });
});
