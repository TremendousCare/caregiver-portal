// Unit tests for src/lib/clientContacts.js
//
// The helper module does normalization + replace-then-insert against
// Supabase. Tests use a hand-rolled fake Supabase client so we can
// verify exactly which rows get sent without touching the network.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveEmergencyContacts,
  loadEmergencyContacts,
  saveResponsibleParties,
  loadResponsibleParties,
} from '../clientContacts';

// ─── Fake Supabase client ────────────────────────────────────
// Mimics the bits of the supabase-js builder pattern we use.
// Records every call so tests can assert against them.

function createFakeSupabase({ selectData = [], errors = {} } = {}) {
  const calls = [];
  function table(name) {
    return {
      _table: name,
      insert(rows) {
        calls.push({ op: 'insert', table: name, rows });
        return Promise.resolve({ error: errors.insert ?? null });
      },
      delete() {
        return {
          eq(col, val) {
            calls.push({ op: 'delete', table: name, where: { [col]: val } });
            return Promise.resolve({ error: errors.delete ?? null });
          },
        };
      },
      select(cols) {
        return {
          eq(col, val) {
            // The real supabase-js builder is a thenable: you can
            // either await the .eq() directly OR chain .order().
            // Test mock mirrors that — it returns an object that is
            // both a Promise (via .then) and has .order().
            const baseCall = { op: 'select', table: name, cols, where: { [col]: val } };
            const resolved = { data: selectData, error: errors.select ?? null };
            return {
              order(orderCol, opts) {
                calls.push({ ...baseCall, order: { col: orderCol, ...opts } });
                return Promise.resolve(resolved);
              },
              then(onFulfilled, onRejected) {
                calls.push(baseCall);
                return Promise.resolve(resolved).then(onFulfilled, onRejected);
              },
            };
          },
        };
      },
    };
  }
  return {
    from: (name) => table(name),
    _calls: calls,
  };
}

// ─── saveEmergencyContacts ───────────────────────────────────

describe('saveEmergencyContacts', () => {
  let client;
  beforeEach(() => { client = createFakeSupabase(); });

  it('no-ops cleanly when supabase is missing', async () => {
    const result = await saveEmergencyContacts('cl-1', [{ name: 'X', phone: '555' }], null);
    expect(result).toEqual({ saved: 0, error: null });
  });

  it('no-ops cleanly when clientId is missing', async () => {
    const result = await saveEmergencyContacts(null, [{ name: 'X', phone: '555' }], client);
    expect(result).toEqual({ saved: 0, error: null });
    expect(client._calls).toHaveLength(0);
  });

  it('deletes existing rows then inserts new ones (replace semantics)', async () => {
    const contacts = [
      { name: 'Alice', phone: '111', relationship: 'Daughter', email: 'a@x.com' },
      { name: 'Bob',   phone: '222', altPhone: '222b' },
    ];
    const result = await saveEmergencyContacts('cl-1', contacts, client);

    expect(result.error).toBeNull();
    expect(result.saved).toBe(2);

    expect(client._calls[0]).toEqual({ op: 'delete', table: 'client_emergency_contacts', where: { client_id: 'cl-1' } });
    expect(client._calls[1].op).toBe('insert');
    expect(client._calls[1].rows).toEqual([
      { client_id: 'cl-1', priority: 1, name: 'Alice', relationship: 'Daughter', phone: '111', alt_phone: null, email: 'a@x.com', notes: null },
      { client_id: 'cl-1', priority: 2, name: 'Bob',   relationship: null,       phone: '222', alt_phone: '222b', email: null, notes: null },
    ]);
  });

  it('skips rows missing name or phone (empty slot, not data)', async () => {
    const contacts = [
      { name: '',       phone: '111' },         // missing name → skip
      { name: 'Real',   phone: '222' },         // keep, becomes priority 1
      { name: 'NoPhone' },                      // missing phone → skip
      { name: '   ',    phone: '333' },         // whitespace-only name → skip
    ];
    const result = await saveEmergencyContacts('cl-1', contacts, client);
    expect(result.saved).toBe(1);
    expect(client._calls[1].rows).toEqual([
      { client_id: 'cl-1', priority: 1, name: 'Real', relationship: null, phone: '222', alt_phone: null, email: null, notes: null },
    ]);
  });

  it('deletes-only and skips insert when every row is empty', async () => {
    const result = await saveEmergencyContacts('cl-1', [{ name: '', phone: '' }], client);
    expect(result.saved).toBe(0);
    expect(result.error).toBeNull();
    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('delete');
  });

  it('returns the delete error and skips insert when delete fails', async () => {
    const c = createFakeSupabase({ errors: { delete: new Error('delete-blew-up') } });
    const result = await saveEmergencyContacts('cl-1', [{ name: 'A', phone: '1' }], c);
    expect(result.saved).toBe(0);
    expect(result.error.message).toBe('delete-blew-up');
    expect(c._calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('returns the insert error when insert fails', async () => {
    const c = createFakeSupabase({ errors: { insert: new Error('insert-blew-up') } });
    const result = await saveEmergencyContacts('cl-1', [{ name: 'A', phone: '1' }], c);
    expect(result.saved).toBe(0);
    expect(result.error.message).toBe('insert-blew-up');
  });

  it('priority is 1-based and reflects array order', async () => {
    await saveEmergencyContacts('cl-1', [
      { name: 'First',  phone: '1' },
      { name: 'Second', phone: '2' },
      { name: 'Third',  phone: '3' },
    ], client);
    const rows = client._calls[1].rows;
    expect(rows.map((r) => r.priority)).toEqual([1, 2, 3]);
  });
});

// ─── loadEmergencyContacts ───────────────────────────────────

describe('loadEmergencyContacts', () => {
  it('returns rows ordered by priority asc', async () => {
    const data = [
      { id: 'r1', priority: 1, name: 'A', phone: '1' },
      { id: 'r2', priority: 2, name: 'B', phone: '2' },
    ];
    const client = createFakeSupabase({ selectData: data });
    const rows = await loadEmergencyContacts('cl-1', client);
    expect(rows).toEqual(data);
    expect(client._calls[0].order).toEqual({ col: 'priority', ascending: true });
  });

  it('returns [] when client is missing', async () => {
    expect(await loadEmergencyContacts('cl-1', null)).toEqual([]);
  });

  it('returns [] when clientId is missing', async () => {
    expect(await loadEmergencyContacts(null, createFakeSupabase())).toEqual([]);
  });

  it('returns [] on select error', async () => {
    const client = createFakeSupabase({ errors: { select: new Error('boom') } });
    expect(await loadEmergencyContacts('cl-1', client)).toEqual([]);
  });
});

// ─── saveResponsibleParties ──────────────────────────────────

describe('saveResponsibleParties', () => {
  let client;
  beforeEach(() => { client = createFakeSupabase(); });

  it('no-ops cleanly when both primary + secondary have empty names', async () => {
    const result = await saveResponsibleParties('cl-1', { primary: { name: '' }, secondary: { name: '   ' } }, client);
    expect(result.saved).toBe(0);
    expect(result.error).toBeNull();
    // Still issues the delete so an edit can "clear" existing RPs.
    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('delete');
  });

  it('writes both primary and secondary when both have names', async () => {
    const result = await saveResponsibleParties('cl-1', {
      primary:   { name: 'Mom', phone: '111', contactFor: ['Billing', 'Scheduling'], hipaaOnFile: true, healthcarePoa: true, isMainPointOfContact: true },
      secondary: { name: 'Dad', phone: '222', contactFor: [], financialPoa: true },
    }, client);

    expect(result.saved).toBe(2);
    const rows = client._calls[1].rows;
    expect(rows).toEqual([
      {
        client_id: 'cl-1', rank: 'primary', name: 'Mom',
        relationship: null, phone: '111', email: null,
        contact_for: ['Billing', 'Scheduling'],
        hipaa_on_file: true, financial_poa: false, healthcare_poa: true,
        is_main_point_of_contact: true, notes: null,
      },
      {
        client_id: 'cl-1', rank: 'secondary', name: 'Dad',
        relationship: null, phone: '222', email: null,
        contact_for: [],
        hipaa_on_file: false, financial_poa: true, healthcare_poa: false,
        is_main_point_of_contact: false, notes: null,
      },
    ]);
  });

  it('clears secondary.is_main_point_of_contact when primary also has it set (avoids UNIQUE violation)', async () => {
    await saveResponsibleParties('cl-1', {
      primary:   { name: 'P', isMainPointOfContact: true },
      secondary: { name: 'S', isMainPointOfContact: true },
    }, client);
    const rows = client._calls[1].rows;
    expect(rows[0].is_main_point_of_contact).toBe(true);
    expect(rows[1].is_main_point_of_contact).toBe(false);
  });

  it('writes only primary when secondary is empty', async () => {
    await saveResponsibleParties('cl-1', {
      primary:   { name: 'OnlyOne', phone: '111' },
      secondary: { name: '' },
    }, client);
    const rows = client._calls[1].rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].rank).toBe('primary');
  });

  it('treats non-array contactFor as empty array (defensive coercion)', async () => {
    await saveResponsibleParties('cl-1', { primary: { name: 'X', contactFor: 'Billing' } }, client);
    expect(client._calls[1].rows[0].contact_for).toEqual([]);
  });

  it('returns the delete error and skips insert when delete fails', async () => {
    const c = createFakeSupabase({ errors: { delete: new Error('del-fail') } });
    const result = await saveResponsibleParties('cl-1', { primary: { name: 'A' } }, c);
    expect(result.error.message).toBe('del-fail');
    expect(c._calls.filter((x) => x.op === 'insert')).toHaveLength(0);
  });

  it('returns the insert error when insert fails', async () => {
    const c = createFakeSupabase({ errors: { insert: new Error('ins-fail') } });
    const result = await saveResponsibleParties('cl-1', { primary: { name: 'A' } }, c);
    expect(result.error.message).toBe('ins-fail');
  });
});

// ─── loadResponsibleParties ──────────────────────────────────

describe('loadResponsibleParties', () => {
  it('returns shape { primary, secondary } when both exist', async () => {
    const data = [
      { id: 'r1', rank: 'secondary', name: 'B' },
      { id: 'r2', rank: 'primary',   name: 'A' },
    ];
    const client = createFakeSupabase({ selectData: data });
    const result = await loadResponsibleParties('cl-1', client);
    expect(result.primary?.name).toBe('A');
    expect(result.secondary?.name).toBe('B');
  });

  it('returns { primary: null, secondary: null } when no rows', async () => {
    const client = createFakeSupabase({ selectData: [] });
    expect(await loadResponsibleParties('cl-1', client)).toEqual({ primary: null, secondary: null });
  });

  it('returns { primary: null, secondary: null } on error', async () => {
    const client = createFakeSupabase({ errors: { select: new Error('x') } });
    expect(await loadResponsibleParties('cl-1', client)).toEqual({ primary: null, secondary: null });
  });

  it('returns { primary: null, secondary: null } when client is missing', async () => {
    expect(await loadResponsibleParties('cl-1', null)).toEqual({ primary: null, secondary: null });
  });
});
