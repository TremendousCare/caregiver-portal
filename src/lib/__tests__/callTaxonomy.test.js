/**
 * Phase 1.6.1 — callTaxonomy frontend helpers.
 *
 * Covers the helper layer that the Settings UI talks to:
 *   * listCallTaxonomy        — table read, sort order
 *   * upsertCallTaxonomyRow   — input validation + RPC shape
 *   * archive / unarchive     — toggles via the upsert RPC
 *   * slugifyLabel            — pure transform, derives the slug
 *                                input default in the UI
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock so the import in callTaxonomy.js picks up the spy.
const supabaseMock = vi.hoisted(() => {
  const rpc = vi.fn();
  // Chainable from-builder. The Settings UI calls
  // .from(...).select(...).order(...).order(...).order(...).
  const orderChain = vi.fn(function () { return orderChainProxy; });
  const orderChainProxy = {
    order: orderChain,
    // Thenable to satisfy `await` at the end of the chain.
    then: (resolve) => resolve(currentReadResult),
  };
  let currentReadResult = { data: [], error: null };
  const from = vi.fn(() => ({
    select: vi.fn(() => orderChainProxy),
  }));
  return {
    from,
    rpc,
    _setReadResult: (next) => { currentReadResult = next; },
    _orderChain:    orderChain,
  };
});

vi.mock('../supabase', () => ({ supabase: supabaseMock }));

// Imported AFTER the mock is registered.
const {
  CALL_TAXONOMY_AXES,
  listCallTaxonomy,
  upsertCallTaxonomyRow,
  archiveCallTaxonomyRow,
  unarchiveCallTaxonomyRow,
  slugifyLabel,
} = await import('../callTaxonomy');

beforeEach(() => {
  supabaseMock.from.mockClear();
  supabaseMock.rpc.mockReset();
  supabaseMock._orderChain.mockClear();
  supabaseMock._setReadResult({ data: [], error: null });
});

describe('CALL_TAXONOMY_AXES', () => {
  it('locks the two-axis taxonomy at the helper boundary', () => {
    expect(CALL_TAXONOMY_AXES).toEqual(['call_type', 'red_flag']);
  });
});

describe('listCallTaxonomy', () => {
  it('reads from call_taxonomy and returns the data array', async () => {
    const rows = [
      { id: 'r1', axis: 'call_type', slug: 'recruiting', label: 'Recruiting', sort_order: 10, is_active: true },
      { id: 'r2', axis: 'red_flag',  slug: 'safety_issue', label: 'Safety',   sort_order: 20, is_active: true },
    ];
    supabaseMock._setReadResult({ data: rows, error: null });
    const out = await listCallTaxonomy();
    expect(out).toEqual(rows);
    expect(supabaseMock.from).toHaveBeenCalledWith('call_taxonomy');
  });

  it('orders by axis → sort_order → created_at', async () => {
    supabaseMock._setReadResult({ data: [], error: null });
    await listCallTaxonomy();
    // Three .order() calls land on the chain.
    expect(supabaseMock._orderChain).toHaveBeenCalledTimes(3);
    expect(supabaseMock._orderChain.mock.calls[0][0]).toBe('axis');
    expect(supabaseMock._orderChain.mock.calls[1][0]).toBe('sort_order');
    expect(supabaseMock._orderChain.mock.calls[2][0]).toBe('created_at');
  });

  it('returns [] when the table is empty', async () => {
    supabaseMock._setReadResult({ data: null, error: null });
    const out = await listCallTaxonomy();
    expect(out).toEqual([]);
  });

  it('throws when supabase returns an error', async () => {
    supabaseMock._setReadResult({ data: null, error: { message: 'boom' } });
    await expect(listCallTaxonomy()).rejects.toThrow();
  });
});

describe('upsertCallTaxonomyRow — input validation', () => {
  it('rejects an axis outside the allowlist', async () => {
    await expect(
      upsertCallTaxonomyRow({ axis: 'other_axis', slug: 'x', label: 'X' }),
    ).rejects.toThrow(/invalid axis/);
  });

  it('rejects an empty slug', async () => {
    await expect(
      upsertCallTaxonomyRow({ axis: 'call_type', slug: '', label: 'X' }),
    ).rejects.toThrow(/slug is required/);
  });

  it('rejects an empty label', async () => {
    await expect(
      upsertCallTaxonomyRow({ axis: 'call_type', slug: 'x', label: '' }),
    ).rejects.toThrow(/label is required/);
  });
});

describe('upsertCallTaxonomyRow — RPC call', () => {
  it('routes through the upsert_call_taxonomy_row_v1 RPC with the canonical params', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: 'new-row-id', error: null });
    const id = await upsertCallTaxonomyRow({
      axis:        'call_type',
      slug:        'recruiting',
      label:       'Recruiting',
      description: 'Outreach calls',
      sortOrder:   10,
      isActive:    true,
    });
    expect(id).toBe('new-row-id');
    expect(supabaseMock.rpc).toHaveBeenCalledWith('upsert_call_taxonomy_row_v1', {
      p_axis:        'call_type',
      p_slug:        'recruiting',
      p_label:       'Recruiting',
      p_description: 'Outreach calls',
      p_sort_order:  10,
      p_is_active:   true,
    });
  });

  it('coerces missing description to null', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: 'id', error: null });
    await upsertCallTaxonomyRow({ axis: 'red_flag', slug: 'safety', label: 'Safety' });
    expect(supabaseMock.rpc.mock.calls[0][1].p_description).toBeNull();
  });

  it('defaults a non-finite sort order to 0', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: 'id', error: null });
    await upsertCallTaxonomyRow({ axis: 'red_flag', slug: 'safety', label: 'Safety', sortOrder: Number.NaN });
    expect(supabaseMock.rpc.mock.calls[0][1].p_sort_order).toBe(0);
  });

  it('coerces isActive=false to false (archive path)', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: 'id', error: null });
    await upsertCallTaxonomyRow({ axis: 'red_flag', slug: 'safety', label: 'Safety', isActive: false });
    expect(supabaseMock.rpc.mock.calls[0][1].p_is_active).toBe(false);
  });

  it('throws when the RPC returns an error', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'denied' } });
    await expect(
      upsertCallTaxonomyRow({ axis: 'call_type', slug: 'x', label: 'X' }),
    ).rejects.toThrow();
  });
});

describe('archive / unarchive', () => {
  it('archive flips is_active to false but keeps every other field', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: 'id', error: null });
    const row = {
      axis: 'red_flag', slug: 'safety_issue', label: 'Safety',
      description: 'desc', sort_order: 30, is_active: true,
    };
    await archiveCallTaxonomyRow(row);
    expect(supabaseMock.rpc.mock.calls[0][1]).toMatchObject({
      p_axis:        'red_flag',
      p_slug:        'safety_issue',
      p_label:       'Safety',
      p_description: 'desc',
      p_sort_order:  30,
      p_is_active:   false,
    });
  });

  it('unarchive flips is_active to true', async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: 'id', error: null });
    const row = {
      axis: 'red_flag', slug: 'safety_issue', label: 'Safety',
      description: null, sort_order: 30, is_active: false,
    };
    await unarchiveCallTaxonomyRow(row);
    expect(supabaseMock.rpc.mock.calls[0][1].p_is_active).toBe(true);
  });
});

describe('slugifyLabel', () => {
  it('lowercases + replaces non-alphanumerics with underscores', () => {
    expect(slugifyLabel('Recruiting Call')).toBe('recruiting_call');
    expect(slugifyLabel('Client Care!')).toBe('client_care');
    expect(slugifyLabel('  bd  outreach ')).toBe('bd_outreach');
  });

  it('collapses runs of separators into a single underscore', () => {
    expect(slugifyLabel('Legal / HR risk')).toBe('legal_hr_risk');
    expect(slugifyLabel('payment---dispute')).toBe('payment_dispute');
  });

  it('strips leading and trailing underscores', () => {
    expect(slugifyLabel('!!!Other!!!')).toBe('other');
  });

  it('truncates at 60 characters', () => {
    const long = 'a'.repeat(120);
    const out = slugifyLabel(long);
    expect(out.length).toBe(60);
  });

  it('returns an empty string for null / undefined / non-string inputs', () => {
    expect(slugifyLabel(null)).toBe('');
    expect(slugifyLabel(undefined)).toBe('');
    expect(slugifyLabel(123)).toBe('');
  });
});
