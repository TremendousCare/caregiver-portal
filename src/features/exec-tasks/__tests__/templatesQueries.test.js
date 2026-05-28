import { describe, it, expect } from 'vitest';
import {
  fetchTemplates,
  updateTemplate,
  createTemplate,
  validateActivation,
  validateNewTemplateDraft,
  needsNextFireDate,
  slugify,
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
      insertRow: null,
      single: false,
    };
    const chain = {
      select(cols) { state.selectCols = cols; return chain; },
      update(row) { state.updateRow = row; return chain; },
      insert(row) { state.insertRow = row; return chain; },
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

describe('slugify', () => {
  it('lowercases and underscores non-alphanumerics', () => {
    expect(slugify('Monthly P&L review')).toBe('monthly_p_l_review');
  });
  it('trims leading/trailing separators', () => {
    expect(slugify('  Hello!! ')).toBe('hello');
  });
  it('returns empty string for empty/nullish input', () => {
    expect(slugify('')).toBe('');
    expect(slugify(null)).toBe('');
    expect(slugify(undefined)).toBe('');
  });
});

describe('validateNewTemplateDraft', () => {
  it('rejects a missing name', () => {
    const r = validateNewTemplateDraft({ name: '  ', templateType: 'ad_hoc' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/name is required/i);
  });
  it('rejects an unknown template type', () => {
    const r = validateNewTemplateDraft({ name: 'X', templateType: 'bogus' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/template type/i);
  });
  it('rejects a lifecycle template without offset_days', () => {
    const r = validateNewTemplateDraft({ name: 'X', templateType: 'lifecycle', offset_days: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/days after hire/i);
  });
  it('accepts offset_days of 0 for lifecycle', () => {
    expect(validateNewTemplateDraft({ name: 'X', templateType: 'lifecycle', offset_days: 0 }).ok).toBe(true);
  });
  it('rejects a recurring template without a valid interval', () => {
    const r = validateNewTemplateDraft({ name: 'X', templateType: 'recurring', recurrence_interval_days: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/recurrence interval/i);
  });
  it('accepts a valid recurring draft', () => {
    expect(validateNewTemplateDraft({ name: 'X', templateType: 'recurring', recurrence_interval_days: 30 }).ok).toBe(true);
  });
  it('accepts an ad_hoc draft with no timing fields', () => {
    expect(validateNewTemplateDraft({ name: 'X', templateType: 'ad_hoc' }).ok).toBe(true);
  });
});

describe('createTemplate', () => {
  it('rejects when supabase is missing', async () => {
    const r = await createTemplate(null, { orgId: 'o1', draft: { name: 'X', templateType: 'ad_hoc' } });
    expect(r.error.message).toMatch(/not configured/i);
  });

  it('rejects a missing org_id', async () => {
    const sb = makeSupabaseMock();
    const r = await createTemplate(sb, { orgId: '', draft: { name: 'X', templateType: 'ad_hoc' } });
    expect(r.error.message).toMatch(/org_id/i);
    expect(sb._calls.length).toBe(0);
  });

  it('rejects an invalid draft before touching the DB', async () => {
    const sb = makeSupabaseMock();
    const r = await createTemplate(sb, { orgId: 'o1', draft: { name: '', templateType: 'ad_hoc' } });
    expect(r.error.message).toMatch(/name is required/i);
    expect(sb._calls.length).toBe(0);
  });

  it('inserts a recurring template with derived slug, org_id, and inactive default', async () => {
    const sb = makeSupabaseMock({ responder: (state) => ({ data: { id: 'new', ...state.insertRow }, error: null }) });
    const r = await createTemplate(sb, {
      orgId: 'org-1',
      draft: {
        name: 'Monthly board update',
        templateType: 'recurring',
        recurrence_interval_days: '30',
        next_fire_at: '2026-06-01T09:00:00.000Z',
        default_assignee_email: '  KEVIN@TC.COM ',
        default_urgency: 'info',
        description: '  do it  ',
      },
    });
    expect(r.error).toBe(null);
    const row = sb._calls[0].insertRow;
    expect(row.org_id).toBe('org-1');
    expect(row.category).toBe('recurring');
    expect(row.anchor_type).toBe('fixed_date');
    expect(row.recurrence_interval_days).toBe(30);
    expect(row.offset_days).toBe(null);
    expect(row.next_fire_at).toBe('2026-06-01T09:00:00.000Z');
    expect(row.active).toBe(false);
    expect(row.visibility).toBe('owner');
    expect(row.default_assignee_email).toBe('kevin@tc.com');
    expect(row.description).toBe('do it');
    expect(row.structured_questions).toEqual([]);
    expect(row.slug.startsWith('monthly_board_update_')).toBe(true);
  });

  it('maps lifecycle type to hire_date with offset_days', async () => {
    const sb = makeSupabaseMock({ responder: (state) => ({ data: state.insertRow, error: null }) });
    await createTemplate(sb, {
      orgId: 'org-1',
      draft: { name: '30-day check-in', templateType: 'lifecycle', offset_days: '30' },
    });
    const row = sb._calls[0].insertRow;
    expect(row.category).toBe('lifecycle');
    expect(row.anchor_type).toBe('hire_date');
    expect(row.offset_days).toBe(30);
    expect(row.recurrence_interval_days).toBe(null);
    expect(row.next_fire_at).toBe(null);
  });

  it('rejects a non-array structured_questions before hitting the DB', async () => {
    const sb = makeSupabaseMock();
    const r = await createTemplate(sb, {
      orgId: 'org-1',
      draft: { name: 'X', templateType: 'ad_hoc', structured_questions: { not: 'array' } },
    });
    expect(r.error.message).toMatch(/must be an array/i);
    expect(sb._calls.length).toBe(0);
  });

  it('translates a unique-violation into a friendly message', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: null, error: { code: '23505', message: 'dup' } }) });
    const r = await createTemplate(sb, {
      orgId: 'org-1',
      draft: { name: 'X', templateType: 'ad_hoc' },
    });
    expect(r.error.message).toMatch(/already exists/i);
  });
});
