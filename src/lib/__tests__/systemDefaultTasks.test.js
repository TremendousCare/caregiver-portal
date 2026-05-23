// Unit tests for src/lib/systemDefaultTasks.js

import { describe, it, expect } from 'vitest';
import {
  loadActiveSystemDefaults,
  dbToSystemDefaultTask,
  isSystemDefaultTask,
  SYSTEM_DEFAULT_SOURCE,
} from '../systemDefaultTasks';

// ─── Fake Supabase client mirroring the bits we use ─────────

function createFakeClient({ rows = [], error = null } = {}) {
  const calls = [];
  return {
    from(table) {
      return {
        select(cols) {
          return {
            eq(col, val) {
              return {
                order(orderCol, opts) {
                  calls.push({ table, cols, eq: { [col]: val }, order: { col: orderCol, ...opts } });
                  return Promise.resolve({ data: rows, error });
                },
              };
            },
          };
        },
      };
    },
    _calls: calls,
  };
}

// ─── dbToSystemDefaultTask ─────────────────────────────────────

describe('dbToSystemDefaultTask', () => {
  it('maps every field from snake_case to the care_plan_tasks-compatible shape', () => {
    const out = dbToSystemDefaultTask({
      id: 'sd-1',
      org_id: 'org-1',
      category: 'caregiver.hygiene',
      task_name: 'Hand hygiene',
      description: 'Wash hands',
      shifts: ['all'],
      days_of_week: [],
      priority: 'critical',
      safety_notes: null,
      sort_order: 1,
      is_active: true,
      created_at: 'c1',
      updated_at: 'c2',
    });
    expect(out).toEqual({
      id: 'sd-1',
      versionId: null,
      category: 'caregiver.hygiene',
      taskName: 'Hand hygiene',
      description: 'Wash hands',
      shifts: ['all'],
      daysOfWeek: [],
      priority: 'critical',
      safetyNotes: null,
      sortOrder: 1,
      isActive: true,
      __source: SYSTEM_DEFAULT_SOURCE,
      createdAt: 'c1',
      updatedAt: 'c2',
    });
  });

  it('returns null for null input', () => {
    expect(dbToSystemDefaultTask(null)).toBeNull();
  });

  it('treats is_active === undefined as active (defensive default)', () => {
    const out = dbToSystemDefaultTask({ id: 'sd-1', category: 'x', task_name: 'y' });
    expect(out.isActive).toBe(true);
  });

  it('treats is_active === false as inactive', () => {
    const out = dbToSystemDefaultTask({ id: 'sd-1', category: 'x', task_name: 'y', is_active: false });
    expect(out.isActive).toBe(false);
  });

  it('defaults missing shifts to ["all"] (matches dbToCarePlanTask)', () => {
    const out = dbToSystemDefaultTask({ id: 'sd-1', category: 'x', task_name: 'y' });
    expect(out.shifts).toEqual(['all']);
  });

  it('defaults missing days_of_week to [] (matches dbToCarePlanTask)', () => {
    const out = dbToSystemDefaultTask({ id: 'sd-1', category: 'x', task_name: 'y' });
    expect(out.daysOfWeek).toEqual([]);
  });
});

// ─── isSystemDefaultTask ─────────────────────────────────────

describe('isSystemDefaultTask', () => {
  it('true for objects with __source === system_default', () => {
    expect(isSystemDefaultTask({ id: 'sd-1', __source: SYSTEM_DEFAULT_SOURCE })).toBe(true);
  });

  it('false for objects without __source (care_plan_tasks rows)', () => {
    expect(isSystemDefaultTask({ id: 'task-1', category: 'adl.bathing' })).toBe(false);
  });

  it('false for null / undefined', () => {
    expect(isSystemDefaultTask(null)).toBe(false);
    expect(isSystemDefaultTask(undefined)).toBe(false);
  });

  it('false for objects with a different __source value', () => {
    expect(isSystemDefaultTask({ __source: 'something_else' })).toBe(false);
  });
});

// ─── loadActiveSystemDefaults ─────────────────────────────────

describe('loadActiveSystemDefaults', () => {
  it('returns mapped active rows ordered by sort_order asc', async () => {
    const rows = [
      { id: 'sd-1', category: 'caregiver.hygiene', task_name: 'Hand hygiene', sort_order: 1, is_active: true },
      { id: 'sd-2', category: 'caregiver.break',   task_name: 'Caregiver break', sort_order: 100, is_active: true },
    ];
    const client = createFakeClient({ rows });
    const out = await loadActiveSystemDefaults(client);
    expect(out).toHaveLength(2);
    expect(out[0].taskName).toBe('Hand hygiene');
    expect(out[1].taskName).toBe('Caregiver break');
    expect(out.every((t) => t.__source === SYSTEM_DEFAULT_SOURCE)).toBe(true);
    expect(client._calls[0].order).toEqual({ col: 'sort_order', ascending: true });
    expect(client._calls[0].eq).toEqual({ is_active: true });
  });

  it('returns [] when the client is missing (e.g. dev/test without Supabase)', async () => {
    expect(await loadActiveSystemDefaults(null)).toEqual([]);
  });

  it('returns [] on query error (never blocks the checklist from rendering)', async () => {
    const client = createFakeClient({ error: new Error('boom') });
    expect(await loadActiveSystemDefaults(client)).toEqual([]);
  });

  it('returns [] when data is null (Supabase quirk on empty results)', async () => {
    const client = createFakeClient({ rows: null });
    expect(await loadActiveSystemDefaults(client)).toEqual([]);
  });
});
