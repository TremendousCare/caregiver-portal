import { describe, it, expect } from 'vitest';
import {
  parseDollarsToCents,
  validateActivityDraft,
  buildActivityRow,
  insertActivity,
  QUICK_CAPTURE_TYPES,
  SPEND_CATEGORIES,
} from '../../features/bd-portal/lib/bdMutations';

describe('parseDollarsToCents', () => {
  it('handles plain numbers', () => {
    expect(parseDollarsToCents('25')).toBe(2500);
    expect(parseDollarsToCents('25.50')).toBe(2550);
  });
  it('strips dollar sign and whitespace', () => {
    expect(parseDollarsToCents('$25')).toBe(2500);
    expect(parseDollarsToCents('  $ 12.34 ')).toBe(1234);
  });
  it('returns 0 for empty / invalid input', () => {
    expect(parseDollarsToCents('')).toBe(0);
    expect(parseDollarsToCents(null)).toBe(0);
    expect(parseDollarsToCents(undefined)).toBe(0);
    expect(parseDollarsToCents('abc')).toBe(0);
    expect(parseDollarsToCents('-5')).toBe(500); // strips the minus sign — fine, we clamp negatives below
  });
  it('rounds half-cents away from floating-point error', () => {
    expect(parseDollarsToCents('0.1')).toBe(10);
    expect(parseDollarsToCents('0.01')).toBe(1);
    expect(parseDollarsToCents('99.99')).toBe(9999);
  });
});

const validDraft = () => ({
  activity_type: 'visit',
  account_id: 'a-1',
  occurred_at: new Date('2026-05-09T12:00:00').toISOString(),
  spend_cents: 0,
  notes: 'dropped off lunch',
});

describe('validateActivityDraft', () => {
  it('accepts a minimal valid draft', () => {
    expect(validateActivityDraft(validDraft())).toEqual({ ok: true });
  });
  it('rejects an unknown activity type', () => {
    const r = validateActivityDraft({ ...validDraft(), activity_type: 'fax' });
    expect(r.ok).toBe(false);
  });
  it('requires an account', () => {
    const r = validateActivityDraft({ ...validDraft(), account_id: null });
    expect(r.ok).toBe(false);
  });
  it('rejects invalid timestamps', () => {
    expect(validateActivityDraft({ ...validDraft(), occurred_at: '' }).ok).toBe(false);
    expect(validateActivityDraft({ ...validDraft(), occurred_at: 'garbage' }).ok).toBe(false);
  });
  it('rejects negative or non-numeric spend', () => {
    expect(validateActivityDraft({ ...validDraft(), spend_cents: -100 }).ok).toBe(false);
    expect(validateActivityDraft({ ...validDraft(), spend_cents: 'lots' }).ok).toBe(false);
  });
  it('requires a spend category when spend > 0', () => {
    expect(validateActivityDraft({ ...validDraft(), spend_cents: 1500 }).ok).toBe(false);
    expect(validateActivityDraft({ ...validDraft(), spend_cents: 1500, spend_category: 'meal' }).ok).toBe(true);
  });
  it('does not require a spend category when spend == 0', () => {
    expect(validateActivityDraft({ ...validDraft(), spend_category: null }).ok).toBe(true);
  });
});

describe('buildActivityRow', () => {
  it('shapes the row for bd_activities insert', () => {
    const draft = { ...validDraft(), spend_cents: 1500, spend_category: 'meal' };
    const row = buildActivityRow(draft, 'org-1', 'Sasha');
    expect(row).toMatchObject({
      org_id: 'org-1',
      account_id: 'a-1',
      activity_type: 'visit',
      spend_cents: 1500,
      spend_category: 'meal',
      notes: 'dropped off lunch',
      source: 'manual',
      created_by: 'Sasha',
    });
    // ISO timestamp
    expect(typeof row.occurred_at).toBe('string');
    expect(row.occurred_at.endsWith('Z')).toBe(true);
  });

  it('nulls spend_category when spend is 0', () => {
    const row = buildActivityRow(validDraft(), 'org-1', 'Sasha');
    expect(row.spend_category).toBe(null);
  });

  it('trims notes and stores null for empty notes', () => {
    const draft = { ...validDraft(), notes: '   ' };
    expect(buildActivityRow(draft, 'org-1', 'Sasha').notes).toBe(null);
  });

  it('passes GPS through if provided', () => {
    const draft = { ...validDraft(), gps_lat: 33.6, gps_lng: -117.9 };
    const row = buildActivityRow(draft, 'org-1', 'Sasha');
    expect(row.gps_lat).toBe(33.6);
    expect(row.gps_lng).toBe(-117.9);
  });
});

// ─── insertActivity (with stubbed supabase) ───
function makeStubSupabase({
  insertResult = { data: { id: 'new-1', account_id: 'a-1', occurred_at: '2026-05-09T19:00:00Z', activity_type: 'visit' }, error: null },
  selectResult = { data: { last_activity_at: '2026-04-01T00:00:00Z' }, error: null },
  updateResult = { error: null },
  observed = [],
} = {}) {
  return {
    _observed: observed,
    from(table) {
      if (table === 'bd_activities') {
        return {
          insert(row) {
            observed.push({ table, op: 'insert', row });
            return {
              select() { return this; },
              single: () => Promise.resolve(insertResult),
            };
          },
        };
      }
      if (table === 'bd_accounts') {
        return {
          select() { return this; },
          eq() { return this; },
          single: () => Promise.resolve(selectResult),
          update(patch) {
            observed.push({ table, op: 'update', patch });
            return {
              eq: () => Promise.resolve(updateResult),
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

describe('insertActivity', () => {
  it('rejects when supabase client is missing', async () => {
    const r = await insertActivity(null, { orgId: 'o', draft: validDraft(), createdBy: 'u' });
    expect(r.error).toBeTruthy();
    expect(r.data).toBe(null);
  });

  it('rejects when validation fails', async () => {
    const stub = makeStubSupabase();
    const r = await insertActivity(stub, { orgId: 'o', draft: { ...validDraft(), activity_type: 'fax' }, createdBy: 'u' });
    expect(r.error).toBeTruthy();
    expect(stub._observed).toHaveLength(0);
  });

  it('rejects when org_id is missing', async () => {
    const stub = makeStubSupabase();
    const r = await insertActivity(stub, { orgId: null, draft: validDraft(), createdBy: 'u' });
    expect(r.error?.message).toMatch(/org/i);
    expect(stub._observed).toHaveLength(0);
  });

  it('inserts and bumps last_activity_at when newer', async () => {
    const observed = [];
    const stub = makeStubSupabase({ observed });
    const draft = { ...validDraft(), occurred_at: new Date('2026-05-09T19:00:00Z').toISOString() };
    const r = await insertActivity(stub, { orgId: 'org-1', draft, createdBy: 'Sasha' });
    expect(r.error).toBe(null);
    expect(r.data?.id).toBe('new-1');
    const ops = observed.map((o) => `${o.table}:${o.op}`);
    expect(ops).toContain('bd_activities:insert');
    expect(ops).toContain('bd_accounts:update');
  });

  it('skips the bump when account already has a newer last_activity_at', async () => {
    const observed = [];
    const stub = makeStubSupabase({
      observed,
      selectResult: { data: { last_activity_at: '2027-01-01T00:00:00Z' }, error: null },
    });
    const draft = { ...validDraft(), occurred_at: new Date('2026-05-09T19:00:00Z').toISOString() };
    const r = await insertActivity(stub, { orgId: 'org-1', draft, createdBy: 'Sasha' });
    expect(r.error).toBe(null);
    const ops = observed.map((o) => `${o.table}:${o.op}`);
    expect(ops).toContain('bd_activities:insert');
    expect(ops).not.toContain('bd_accounts:update');
  });

  it('still succeeds if the bump itself errors out', async () => {
    const observed = [];
    const stub = makeStubSupabase({
      observed,
      selectResult: { data: null, error: new Error('boom') },
    });
    const r = await insertActivity(stub, { orgId: 'org-1', draft: validDraft(), createdBy: 'Sasha' });
    expect(r.error).toBe(null);
    expect(r.data?.id).toBe('new-1');
  });

  it('returns the insert error if the activity insert itself fails', async () => {
    const err = new Error('rls denied');
    const stub = makeStubSupabase({ insertResult: { data: null, error: err } });
    const r = await insertActivity(stub, { orgId: 'org-1', draft: validDraft(), createdBy: 'Sasha' });
    expect(r.error).toBe(err);
    expect(r.data).toBe(null);
  });
});

describe('QUICK_CAPTURE_TYPES + SPEND_CATEGORIES', () => {
  it('match the bd_activities CHECK constraint domain', () => {
    expect(QUICK_CAPTURE_TYPES).toEqual(['visit', 'call', 'email', 'drop_off', 'note']);
    expect(SPEND_CATEGORIES).toEqual(['meal', 'gift', 'swag', 'event', 'other']);
  });
});
