import { describe, it, expect } from 'vitest';
import {
  fetchStaff,
  createStaff,
  updateStaff,
  deactivateStaff,
  deleteStaff,
  validateStaffDraft,
} from '../lib/staffQueries';

function makeSupabaseMock(opts = {}) {
  const calls = [];
  function builder(tableName) {
    const state = {
      table: tableName,
      filters: [],
      orderArgs: [],
      selectCols: null,
      insertRow: null,
      updateRow: null,
      deleted: false,
      single: false,
    };
    const chain = {
      select(cols) { state.selectCols = cols; return chain; },
      insert(row) { state.insertRow = row; return chain; },
      update(row) { state.updateRow = row; return chain; },
      delete() { state.deleted = true; return chain; },
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

// ─── validateStaffDraft ──────────────────────────────────────

describe('validateStaffDraft', () => {
  const valid = {
    first_name: 'Kevin',
    last_name: 'Nash',
    email: 'kevin@tc.com',
    hire_date: '2020-01-01',
  };

  it('accepts a minimal valid draft', () => {
    expect(validateStaffDraft(valid).ok).toBe(true);
  });
  it('rejects blank first name', () => {
    expect(validateStaffDraft({ ...valid, first_name: '   ' }).ok).toBe(false);
  });
  it('rejects missing email', () => {
    expect(validateStaffDraft({ ...valid, email: 'not an email' }).ok).toBe(false);
  });
  it('rejects missing hire_date', () => {
    expect(validateStaffDraft({ ...valid, hire_date: '' }).ok).toBe(false);
  });
  it('rejects malformed hire_date', () => {
    expect(validateStaffDraft({ ...valid, hire_date: '2020/01/01' }).ok).toBe(false);
    expect(validateStaffDraft({ ...valid, hire_date: 'today' }).ok).toBe(false);
  });
  it('accepts a valid end_date >= hire_date', () => {
    expect(validateStaffDraft({ ...valid, end_date: '2025-06-01' }).ok).toBe(true);
  });
  it('rejects end_date before hire_date', () => {
    expect(validateStaffDraft({ ...valid, hire_date: '2025-01-01', end_date: '2024-12-31' }).ok).toBe(false);
  });
  it('rejects malformed end_date', () => {
    expect(validateStaffDraft({ ...valid, end_date: '06/01/2025' }).ok).toBe(false);
  });
  it('accepts missing manager_email', () => {
    expect(validateStaffDraft({ ...valid, manager_email: '' }).ok).toBe(true);
    expect(validateStaffDraft({ ...valid, manager_email: undefined }).ok).toBe(true);
  });
  it('rejects malformed manager_email', () => {
    expect(validateStaffDraft({ ...valid, manager_email: 'not-an-email' }).ok).toBe(false);
  });
});

// ─── fetchStaff ──────────────────────────────────────────────

describe('fetchStaff', () => {
  it('selects all columns, active-first, then by hire_date ascending', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: [], error: null }) });
    await fetchStaff(sb);
    expect(sb._calls[0].table).toBe('staff_members');
    expect(sb._calls[0].orderArgs).toEqual([
      ['active', { ascending: false }],
      ['hire_date', { ascending: true }],
    ]);
  });
  it('filters to active when includeInactive=false', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: [], error: null }) });
    await fetchStaff(sb, { includeInactive: false });
    expect(sb._calls[0].filters).toEqual([['eq', 'active', true]]);
  });
  it('returns empty data when supabase is null', async () => {
    const r = await fetchStaff(null);
    expect(r.data).toEqual([]);
  });
});

// ─── createStaff ─────────────────────────────────────────────

describe('createStaff', () => {
  const draft = {
    email: '  KEVIN@TC.COM ',
    first_name: '  Kevin  ',
    last_name: ' Nash ',
    role_title: '  Owner  ',
    manager_email: ' BLERTA@TC.COM ',
    hire_date: '2020-01-01',
    end_date: null,
    active: true,
    notes: '  founder  ',
  };

  it('rejects without orgId', async () => {
    const sb = makeSupabaseMock();
    const r = await createStaff(sb, { orgId: null, draft });
    expect(r.error.message).toMatch(/Missing org_id/);
  });

  it('rejects on validation failure', async () => {
    const sb = makeSupabaseMock();
    const r = await createStaff(sb, { orgId: 'org-1', draft: { ...draft, email: 'oops' } });
    expect(r.error.message).toMatch(/email/i);
    expect(sb._calls.length).toBe(0);
  });

  it('normalizes (trim + lowercase email + manager_email)', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: { id: 'new', ...state.insertRow }, error: null }),
    });
    const r = await createStaff(sb, { orgId: 'org-1', draft });
    expect(r.error).toBe(null);
    const row = sb._calls[0].insertRow;
    expect(row.org_id).toBe('org-1');
    expect(row.email).toBe('kevin@tc.com');
    expect(row.manager_email).toBe('blerta@tc.com');
    expect(row.first_name).toBe('Kevin');
    expect(row.last_name).toBe('Nash');
    expect(row.role_title).toBe('Owner');
    expect(row.notes).toBe('founder');
  });

  it('treats missing optional fields as null', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.insertRow, error: null }),
    });
    await createStaff(sb, {
      orgId: 'org-1',
      draft: { email: 'a@b.com', first_name: 'A', hire_date: '2020-01-01' },
    });
    const row = sb._calls[0].insertRow;
    expect(row.last_name).toBe(null);
    expect(row.role_title).toBe(null);
    expect(row.manager_email).toBe(null);
    expect(row.notes).toBe(null);
    expect(row.end_date).toBe(null);
    expect(row.active).toBe(true);
  });
});

// ─── updateStaff ─────────────────────────────────────────────

describe('updateStaff', () => {
  it('rejects missing id', async () => {
    const sb = makeSupabaseMock();
    const r = await updateStaff(sb, { id: null, patch: { first_name: 'x' } });
    expect(r.error.message).toMatch(/Missing staff id/);
  });

  it('rejects empty patch', async () => {
    const sb = makeSupabaseMock();
    const r = await updateStaff(sb, { id: 'x', patch: {} });
    expect(r.error.message).toMatch(/No fields/);
  });

  it('only forwards allowed columns', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await updateStaff(sb, {
      id: 'x',
      patch: {
        first_name: 'New',
        email: 'NEW@X.COM',
        org_id: 'cant-change',
        id: 'cant-change',
        created_at: 'cant-change',
      },
    });
    const u = sb._calls[0].updateRow;
    expect(u.first_name).toBe('New');
    expect(u.email).toBe('new@x.com');
    expect(u.org_id).toBeUndefined();
    expect(u.id).toBeUndefined();
    expect(u.created_at).toBeUndefined();
  });

  it('rejects blank first_name in patch', async () => {
    const sb = makeSupabaseMock();
    const r = await updateStaff(sb, { id: 'x', patch: { first_name: '   ' } });
    expect(r.error.message).toMatch(/blank/i);
  });

  it('rejects invalid email in patch', async () => {
    const sb = makeSupabaseMock();
    const r = await updateStaff(sb, { id: 'x', patch: { email: 'oops' } });
    expect(r.error.message).toMatch(/email/i);
  });

  it('rejects malformed hire_date in patch', async () => {
    const sb = makeSupabaseMock();
    const r = await updateStaff(sb, { id: 'x', patch: { hire_date: '2020/01/01' } });
    expect(r.error.message).toMatch(/YYYY-MM-DD/);
  });

  it('rejects malformed end_date in patch', async () => {
    const sb = makeSupabaseMock();
    const r = await updateStaff(sb, { id: 'x', patch: { end_date: '12/01/2025' } });
    expect(r.error.message).toMatch(/YYYY-MM-DD/);
  });

  it('allows clearing end_date by passing null', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    const r = await updateStaff(sb, { id: 'x', patch: { end_date: null } });
    expect(r.error).toBe(null);
    expect(sb._calls[0].updateRow.end_date).toBe(null);
  });

  it('lowercases manager_email or sets null when blank', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await updateStaff(sb, { id: 'x', patch: { manager_email: 'KEVIN@TC.COM' } });
    expect(sb._calls[0].updateRow.manager_email).toBe('kevin@tc.com');

    const sb2 = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await updateStaff(sb2, { id: 'x', patch: { manager_email: '' } });
    expect(sb2._calls[0].updateRow.manager_email).toBe(null);
  });
});

// ─── deactivateStaff ────────────────────────────────────────

describe('deactivateStaff', () => {
  it('flips active=false and sets end_date in one update', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await deactivateStaff(sb, { id: 'x', endDate: '2025-06-15' });
    const u = sb._calls[0].updateRow;
    expect(u.active).toBe(false);
    expect(u.end_date).toBe('2025-06-15');
  });

  it('end_date is optional (left null when not supplied)', async () => {
    const sb = makeSupabaseMock({
      responder: (state) => ({ data: state.updateRow, error: null }),
    });
    await deactivateStaff(sb, { id: 'x' });
    expect(sb._calls[0].updateRow.end_date).toBe(null);
  });
});

// ─── deleteStaff ────────────────────────────────────────────

describe('deleteStaff', () => {
  it('deletes by id', async () => {
    const sb = makeSupabaseMock({ responder: () => ({ data: null, error: null }) });
    const r = await deleteStaff(sb, 'x');
    expect(r.error).toBe(null);
    expect(sb._calls[0].deleted).toBe(true);
    expect(sb._calls[0].filters).toEqual([['eq', 'id', 'x']]);
  });
  it('rejects missing id', async () => {
    const r = await deleteStaff(makeSupabaseMock(), null);
    expect(r.error.message).toMatch(/Missing staff id/);
  });
});
