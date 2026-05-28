import { describe, it, expect } from 'vitest';
import {
  fetchTemplates,
  updateTemplate,
  validateActivation,
  needsNextFireDate,
} from '../lib/templatesQueries';

function makeSupabaseMock(opts = {}) {
  const calls = [];
  function builder(tableName) {
    const state = {
      table: tableName,
      filters: [],
      orderArgs: [],
      selectCols: null,
      updateRow: null,
      single: false,
    };
    const chain = {
      select(cols) { state.selectCols = cols; return chain; },
      update(row) { state.updateRow = row; return chain; },
      eq(col, val) { state.filters.push(['eq', col, val]); return chain; },
      order(col, o) { state.orderArgs.push([col, o]); return chain; },
      single() { state.single = true; return chain; },
      then(resolve, reject) {
        calls.push(state);
        const result = opts.responder ? opts.responder(state) : { data: null, error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }
  return { from: builder, _calls: calls };
}

describe('needsNextFireDate', () => {
  it('true for fixed_date template missing next_fire_at', () => {
    expect(needsNextFireDate({ anchor_type: 'fixed_date', next_fire_at: null })).toBe(true);
  });
  it('false for fixed_date template with next_fire_at set', () => {
    expect(needsNextFireDate({ anchor_type: 'fixed_date', next_fire_at: '2026-06-01T09:00:00Z' })).toBe(false);
  });
  it('false for hire_date template (uses staff hire_date as anchor)', () => {
    expect(needsNextFireDate({ anchor_type: 'hire_date', next_fire_at: null })).toBe(false);
  });
  it('false for manual templates', () => {
    expect(needsNextFireDate({ anchor_type: 'manual', next_fire_at: null })).toBe(false);
  });
  it('false for null template', () => {
    expect(needsNextFireDate(null)).toBe(false);
  });
});

describe('validateActivation', () => {
  it('passes when not activating', () => {
    expect(validateActivation({ anchor_type: 'fixed_date', next_fire_at: null }, { active: false }).ok).toBe(true);
  });
  it('passes when activating a hire_date template', () => {
    expect(validateActivation({ anchor_type: 'hire_date' }, { active: true }).ok).toBe(true);
  });
  it('rejects activating a fixed_date template with no next_fire_at', () => {
    const r = validateActivation({ anchor_type: 'fixed_date', next_fire_at: null }, { active: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/next fire date/i);
  });
  it('passes when patch supplies next_fire_at', () => {
    const r = validateActivation(
      { anchor_type: 'fixed_date', next_fire_at: null },
      { active: true, next_fire_at: '2026-06-01T09:00:00Z' },
    );
    expect(r.ok).toBe(true);
  });
  it('passes when template already has next_fire_at and patch only toggles active', () => {
    const r = validateActivation(
      { anchor_type: 'fixed_date', next_fire_at: '2026-06-01T09:00:00Z' },
      { active: true },
    );
    expect(r.ok).toBe(true);
  });
});

describe('fetchTemplates', () => {
  it('queries exec_task_templates ordered by sort_order then name', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: [{ id: 'a' }], error: null }) });
    const r = await fetchTemplates(sb);
    expect(r.error).toBe(null);
    expect(r.data).toEqual([{ id: 'a' }]);
    expect(sb._calls[0].table).toBe('exec_task_templates');
    expect(sb._calls[0].orderArgs).toEqual([
      ['sort_order', { ascending: true }],
      ['name', { ascending: true }],
    ]);
  });
  it('returns empty data when supabase is null', async () => {
    const r = await fetchTemplates(null);
    expect(r.data).toEqual([]);
  });
});

describe('updateTemplate', () => {
  it('rejects on missing id', async () => {
    const sb = makeSupabaseMock();
    const r = await updateTemplate(sb, { id: null, patch: { name: 'x' } });
    expect(r.error.message).toMatch(/Missing template id/);
  });

  it('rejects on empty patch', async () => {
    const sb = makeSupabaseMock();
    const r = await updateTemplate(sb, { id: 't1', template: {}, patch: {} });
    expect(r.error.message).toMatch(/No fields/i);
  });

  it('rejects activating fixed_date template without next_fire_at', async () => {
    const sb = makeSupabaseMock();
    const r = await updateTemplate(sb, {
      id: 't1',
      template: { anchor_type: 'fixed_date', next_fire_at: null },
      patch: { active: true },
    });
    expect(r.error.message).toMatch(/next fire date/i);
    expect(sb._calls.length).toBe(0);
  });

  it('forwards only allowed columns', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await updateTemplate(sb, {
      id: 't1',
      template: { anchor_type: 'hire_date' },
      patch: {
        name: 'New',
        org_id: 'cant-change',
        id: 'cant-change',
        slug: 'cant-change',
        category: 'cant-change',
        anchor_type: 'cant-change',
        bogus: 1,
      },
    });
    const u = sb._calls[0].updateRow;
    expect(u.name).toBe('New');
    expect(u.org_id).toBeUndefined();
    expect(u.id).toBeUndefined();
    expect(u.slug).toBeUndefined();
    expect(u.category).toBeUndefined();
    expect(u.anchor_type).toBeUndefined();
    expect(u.bogus).toBeUndefined();
  });

  it('lowercases default_assignee_email', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await updateTemplate(sb, {
      id: 't1',
      template: { anchor_type: 'hire_date' },
      patch: { default_assignee_email: '  KEVIN@TC.COM ' },
    });
    expect(sb._calls[0].updateRow.default_assignee_email).toBe('kevin@tc.com');
  });

  it('rejects non-array structured_questions', async () => {
    const sb = makeSupabaseMock();
    const r = await updateTemplate(sb, {
      id: 't1',
      template: { anchor_type: 'hire_date' },
      patch: { structured_questions: { not: 'an array' } },
    });
    expect(r.error.message).toMatch(/must be an array/);
    expect(sb._calls.length).toBe(0);
  });

  it('accepts an empty structured_questions array', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    const r = await updateTemplate(sb, {
      id: 't1',
      template: { anchor_type: 'hire_date' },
      patch: { structured_questions: [] },
    });
    expect(r.error).toBe(null);
  });
});
