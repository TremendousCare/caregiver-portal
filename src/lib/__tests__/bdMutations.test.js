import { describe, it, expect } from 'vitest';
import {
  parseDollarsToCents,
  validateActivityDraft,
  buildActivityRow,
  insertActivity,
  QUICK_CAPTURE_TYPES,
  SPEND_CATEGORIES,
  splitName,
  validateReferralDraft,
  generateClientId,
  createReferral,
  REFERRAL_LOSS_REASONS,
  CONTACT_ROLES,
  CONTACT_ROLE_LABELS,
  normalizeContactRole,
  validateContactDraft,
  createContact,
  updateContact,
  validateAccountLocationDraft,
  buildAccountLocationPatch,
  updateAccountLocation,
  ACCOUNT_TYPES,
  FACILITY_SUBTYPES,
  PROFESSIONAL_SUBTYPES,
  validateAccountDraft,
  buildAccountRow,
  findAccountDuplicates,
  createAccount,
  createAccountWithContacts,
  buildAccountUpdatePatch,
  updateAccount,
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

// ─── Referral intake (PR #5) ───────────────────────────────────

describe('splitName', () => {
  it('splits "First Last" into the obvious parts', () => {
    expect(splitName('Mary Johnson')).toEqual({ first_name: 'Mary', last_name: 'Johnson' });
  });
  it('joins multi-token last names', () => {
    expect(splitName('Maria Del Rio')).toEqual({ first_name: 'Maria', last_name: 'Del Rio' });
  });
  it('handles single-token names by leaving last_name empty', () => {
    expect(splitName('Mom')).toEqual({ first_name: 'Mom', last_name: '' });
  });
  it('trims excess whitespace', () => {
    expect(splitName('   Sarah   Connor  ')).toEqual({ first_name: 'Sarah', last_name: 'Connor' });
  });
  it('returns empty fields for empty / non-string input', () => {
    expect(splitName('')).toEqual({ first_name: '', last_name: '' });
    expect(splitName(null)).toEqual({ first_name: '', last_name: '' });
    expect(splitName(undefined)).toEqual({ first_name: '', last_name: '' });
    expect(splitName(123)).toEqual({ first_name: '', last_name: '' });
  });
});

const validReferralDraft = () => ({
  account_id: 'a-1',
  contact_id: null,
  prospective_name: 'Mary Johnson',
  prospective_phone: '555-0001',
  prospective_notes: 'Discharge expected Friday.',
  referred_at: new Date('2026-05-09T12:00:00').toISOString(),
});

describe('validateReferralDraft', () => {
  it('accepts a minimal valid draft', () => {
    expect(validateReferralDraft(validReferralDraft())).toEqual({ ok: true });
  });
  it('requires an account', () => {
    expect(validateReferralDraft({ ...validReferralDraft(), account_id: null }).ok).toBe(false);
  });
  it('requires a non-empty prospective name', () => {
    expect(validateReferralDraft({ ...validReferralDraft(), prospective_name: '' }).ok).toBe(false);
    expect(validateReferralDraft({ ...validReferralDraft(), prospective_name: '   ' }).ok).toBe(false);
  });
  it('rejects invalid timestamps', () => {
    expect(validateReferralDraft({ ...validReferralDraft(), referred_at: '' }).ok).toBe(false);
    expect(validateReferralDraft({ ...validReferralDraft(), referred_at: 'garbage' }).ok).toBe(false);
  });
});

describe('generateClientId', () => {
  it('returns a non-empty string', () => {
    expect(typeof generateClientId()).toBe('string');
    expect(generateClientId().length).toBeGreaterThan(8);
  });
  it('returns unique values across calls', () => {
    const a = generateClientId();
    const b = generateClientId();
    expect(a).not.toBe(b);
  });
});

describe('REFERRAL_LOSS_REASONS', () => {
  it('matches the bd_referrals.loss_reason CHECK constraint domain', () => {
    expect(REFERRAL_LOSS_REASONS).toEqual([
      'insurance_denied',
      'chose_other_agency',
      'patient_passed',
      'did_not_qualify',
      'lost_contact',
      'cost',
      'other',
    ]);
  });
});

// ─── createReferral with stubbed supabase ───
function makeReferralStub({
  clientResult        = { data: { id: 'c-new', first_name: 'Mary', last_name: 'Johnson' }, error: null },
  referralResult      = { data: { id: 'r-new', account_id: 'a-1', client_id: 'c-new', status: 'new' }, error: null },
  activityInsertOk    = true,
  accountSelectResult = { data: { last_activity_at: '2026-04-01T00:00:00Z' }, error: null },
  observed            = [],
  clientDeleteFails   = false,
} = {}) {
  return {
    _observed: observed,
    from(table) {
      if (table === 'clients') {
        return {
          insert(row) {
            observed.push({ table, op: 'insert', row });
            return {
              select() { return this; },
              single: () => Promise.resolve(clientResult),
            };
          },
          delete() {
            return {
              eq: (_col, _val) => Promise.resolve(
                clientDeleteFails ? { error: new Error('rollback failed') } : { error: null },
              ),
            };
          },
        };
      }
      if (table === 'bd_referrals') {
        return {
          insert(row) {
            observed.push({ table, op: 'insert', row });
            return {
              select() { return this; },
              single: () => Promise.resolve(referralResult),
            };
          },
        };
      }
      if (table === 'bd_activities') {
        return {
          insert(row) {
            observed.push({ table, op: 'insert', row });
            return {
              select() { return this; },
              single: () => Promise.resolve(
                activityInsertOk
                  ? { data: { id: 'act-new', account_id: row.account_id, occurred_at: row.occurred_at, activity_type: row.activity_type }, error: null }
                  : { data: null, error: new Error('activity insert blocked') },
              ),
            };
          },
        };
      }
      if (table === 'bd_accounts') {
        return {
          select() { return this; },
          eq() { return this; },
          single: () => Promise.resolve(accountSelectResult),
          update() {
            observed.push({ table, op: 'update' });
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

describe('createReferral', () => {
  it('rejects when client is missing', async () => {
    const r = await createReferral(null, { orgId: 'o', draft: validReferralDraft(), createdBy: 'u' });
    expect(r.error).toBeTruthy();
  });

  it('rejects when validation fails', async () => {
    const stub = makeReferralStub();
    const r = await createReferral(stub, { orgId: 'o', draft: { ...validReferralDraft(), account_id: null }, createdBy: 'u' });
    expect(r.error).toBeTruthy();
    expect(stub._observed).toHaveLength(0);
  });

  it('rejects when org_id is missing', async () => {
    const stub = makeReferralStub();
    const r = await createReferral(stub, { orgId: null, draft: validReferralDraft(), createdBy: 'u' });
    expect(r.error?.message).toMatch(/org/i);
    expect(stub._observed).toHaveLength(0);
  });

  it('inserts client, referral, and an activity row on the happy path', async () => {
    const observed = [];
    const stub = makeReferralStub({ observed });
    const r = await createReferral(stub, {
      orgId: 'org-1',
      draft: validReferralDraft(),
      createdBy: 'Sasha',
      accountName: 'Hoag Hospital',
      contactName: 'Sarah Connor',
    });
    expect(r.error).toBe(null);
    expect(r.data?.client?.id).toBe('c-new');
    expect(r.data?.referral?.id).toBe('r-new');
    const ops = observed.map((o) => `${o.table}:${o.op}`);
    expect(ops).toContain('clients:insert');
    expect(ops).toContain('bd_referrals:insert');
    expect(ops).toContain('bd_activities:insert');
  });

  it('seeds clients.notes with referral context (referral_source = account name)', async () => {
    const observed = [];
    const stub = makeReferralStub({ observed });
    await createReferral(stub, {
      orgId: 'org-1',
      draft: validReferralDraft(),
      createdBy: 'Sasha',
      accountName: 'Hoag Hospital',
      contactName: 'Sarah Connor',
    });
    const clientInsert = observed.find((o) => o.table === 'clients' && o.op === 'insert');
    expect(clientInsert.row.referral_source).toBe('Hoag Hospital');
    expect(clientInsert.row.first_name).toBe('Mary');
    expect(clientInsert.row.last_name).toBe('Johnson');
    expect(clientInsert.row.phase).toBe('new_lead');
    expect(Array.isArray(clientInsert.row.notes)).toBe(true);
    expect(clientInsert.row.notes[0].text).toContain('Hoag Hospital');
    expect(clientInsert.row.notes[0].text).toContain('Sarah Connor');
    expect(clientInsert.row.notes[0].text).toContain('Discharge expected Friday.');
  });

  it('rolls back the client when the bd_referrals insert fails', async () => {
    const observed = [];
    const referralErr = new Error('rls denied');
    const stub = makeReferralStub({
      observed,
      referralResult: { data: null, error: referralErr },
    });
    const r = await createReferral(stub, {
      orgId: 'org-1',
      draft: validReferralDraft(),
      createdBy: 'Sasha',
      accountName: 'Hoag',
    });
    expect(r.error).toBe(referralErr);
    // The activity insert should NOT have run.
    expect(observed.find((o) => o.table === 'bd_activities')).toBeUndefined();
  });

  it('still succeeds if the optional activity log fails', async () => {
    const stub = makeReferralStub({ activityInsertOk: false });
    const r = await createReferral(stub, {
      orgId: 'org-1',
      draft: validReferralDraft(),
      createdBy: 'Sasha',
      accountName: 'Hoag',
    });
    expect(r.error).toBe(null);
    expect(r.data?.referral?.id).toBe('r-new');
  });

  it('uses a generated client_id when one is not supplied', async () => {
    const observed = [];
    const stub = makeReferralStub({ observed });
    await createReferral(stub, {
      orgId: 'org-1',
      draft: validReferralDraft(),
      createdBy: 'Sasha',
      accountName: 'Hoag',
    });
    const clientInsert = observed.find((o) => o.table === 'clients' && o.op === 'insert');
    expect(typeof clientInsert.row.id).toBe('string');
    expect(clientInsert.row.id.length).toBeGreaterThan(8);
    const referralInsert = observed.find((o) => o.table === 'bd_referrals' && o.op === 'insert');
    expect(referralInsert.row.client_id).toBe(clientInsert.row.id);
  });
});

// ─── Contact creation (PR #10) ───────────────────────────────

describe('CONTACT_ROLES + CONTACT_ROLE_LABELS', () => {
  it('match the bd_account_contacts.role CHECK constraint domain', () => {
    expect(CONTACT_ROLES).toEqual([
      'discharge_planner', 'case_manager', 'social_worker', 'admissions',
      'ed_director', 'administrator', 'principal', 'physician',
      'gcm', 'attorney', 'financial_planner', 'office_manager', 'other',
    ]);
  });
  it('every role has a human label', () => {
    for (const r of CONTACT_ROLES) {
      expect(CONTACT_ROLE_LABELS[r], `label for ${r}`).toBeTruthy();
    }
  });
});

describe('normalizeContactRole', () => {
  it('passes valid bucket keys through unchanged', () => {
    expect(normalizeContactRole('case_manager')).toBe('case_manager');
    expect(normalizeContactRole('discharge_planner')).toBe('discharge_planner');
  });
  it('is case- and whitespace-tolerant on bucket keys', () => {
    expect(normalizeContactRole('  CASE_MANAGER ')).toBe('case_manager');
  });
  it('matches human labels back to bucket keys', () => {
    expect(normalizeContactRole('Case manager')).toBe('case_manager');
    expect(normalizeContactRole('Discharge planner')).toBe('discharge_planner');
    expect(normalizeContactRole('Geriatric care manager')).toBe('gcm');
  });
  it('returns null for unknown / empty input', () => {
    expect(normalizeContactRole('Director of Marketing')).toBe(null);
    expect(normalizeContactRole('')).toBe(null);
    expect(normalizeContactRole(null)).toBe(null);
    expect(normalizeContactRole(undefined)).toBe(null);
  });
});

const validContactDraft = () => ({
  account_id: 'a-1',
  name: 'Sarah Connor',
  title: 'RN, BSN',
  role: 'case_manager',
  email: 'sconnor@hoag.org',
  phone_mobile: '555-0001',
  phone_office: '',
  notes: '',
  is_primary: false,
});

describe('validateContactDraft', () => {
  it('accepts a minimal valid draft', () => {
    expect(validateContactDraft(validContactDraft())).toEqual({ ok: true });
  });
  it('requires an account', () => {
    expect(validateContactDraft({ ...validContactDraft(), account_id: null }).ok).toBe(false);
  });
  it('requires a non-empty name', () => {
    expect(validateContactDraft({ ...validContactDraft(), name: '' }).ok).toBe(false);
    expect(validateContactDraft({ ...validContactDraft(), name: '   ' }).ok).toBe(false);
  });
  it('rejects an invalid role', () => {
    expect(validateContactDraft({ ...validContactDraft(), role: 'archivist' }).ok).toBe(false);
  });
  it('accepts null/empty role (optional field)', () => {
    expect(validateContactDraft({ ...validContactDraft(), role: null }).ok).toBe(true);
    expect(validateContactDraft({ ...validContactDraft(), role: '' }).ok).toBe(true);
  });
  it('rejects an obviously bad email', () => {
    expect(validateContactDraft({ ...validContactDraft(), email: 'not-an-email' }).ok).toBe(false);
  });
});

// ─── createContact (with stubbed supabase) ───
function makeContactStub({
  existingResult = { data: [], error: null },
  insertResult   = null,
  observed       = [],
} = {}) {
  return {
    _observed: observed,
    from(table) {
      if (table !== 'bd_account_contacts') throw new Error(`unexpected ${table}`);
      return {
        select() {
          return {
            eq() { return this; },
            ilike() { return this; },
            limit: () => Promise.resolve(existingResult),
            single: () => Promise.resolve(insertResult ?? { data: null, error: null }),
          };
        },
        insert(row) {
          observed.push({ op: 'insert', row });
          return {
            select() { return this; },
            single: () => Promise.resolve(insertResult ?? {
              data: { id: 'c-new', ...row },
              error: null,
            }),
          };
        },
      };
    },
  };
}

describe('createContact', () => {
  it('rejects when supabase is missing', async () => {
    const r = await createContact(null, { orgId: 'o', draft: validContactDraft(), createdBy: 'u' });
    expect(r.error).toBeTruthy();
  });

  it('rejects when validation fails', async () => {
    const stub = makeContactStub();
    const r = await createContact(stub, { orgId: 'o', draft: { ...validContactDraft(), name: '' }, createdBy: 'u' });
    expect(r.error).toBeTruthy();
    expect(stub._observed).toHaveLength(0);
  });

  it('rejects without org_id', async () => {
    const stub = makeContactStub();
    const r = await createContact(stub, { orgId: null, draft: validContactDraft(), createdBy: 'u' });
    expect(r.error?.message).toMatch(/org/i);
    expect(stub._observed).toHaveLength(0);
  });

  it('returns the existing contact and skips insert when a duplicate is found', async () => {
    const observed = [];
    const stub = makeContactStub({
      observed,
      existingResult: {
        data: [{ id: 'c-existing', name: 'Sarah Connor', role: 'case_manager' }],
        error: null,
      },
    });
    const r = await createContact(stub, { orgId: 'o', draft: validContactDraft(), createdBy: 'u' });
    expect(r.error).toBe(null);
    expect(r.duplicate).toBe(true);
    expect(r.data?.existing?.id).toBe('c-existing');
    expect(r.data?.created).toBe(null);
    expect(observed.find((o) => o.op === 'insert')).toBeUndefined();
  });

  it('inserts a fresh contact when no duplicate exists', async () => {
    const observed = [];
    const stub = makeContactStub({
      observed,
      insertResult: {
        data: { id: 'c-new', name: 'Sarah Connor', role: 'case_manager' },
        error: null,
      },
    });
    const r = await createContact(stub, { orgId: 'org-1', draft: validContactDraft(), createdBy: 'Sasha' });
    expect(r.error).toBe(null);
    expect(r.duplicate).toBe(false);
    expect(r.data?.created?.id).toBe('c-new');
    const insertOp = observed.find((o) => o.op === 'insert');
    expect(insertOp.row).toMatchObject({
      org_id: 'org-1',
      account_id: 'a-1',
      name: 'Sarah Connor',
      role: 'case_manager',
      email: 'sconnor@hoag.org',
      phone_mobile: '555-0001',
      created_by: 'Sasha',
    });
  });

  it('trims whitespace and converts empty fields to null', async () => {
    const observed = [];
    const stub = makeContactStub({ observed });
    await createContact(stub, {
      orgId: 'o',
      draft: { ...validContactDraft(), name: '  Sarah  ', email: '  ', phone_office: '' },
      createdBy: 'u',
    });
    const insertOp = observed.find((o) => o.op === 'insert');
    expect(insertOp.row.name).toBe('Sarah');
    expect(insertOp.row.email).toBe(null);
    expect(insertOp.row.phone_office).toBe(null);
  });
});

// ─── Contact update ───
function makeUpdateStub({
  updateResult       = { data: { id: 'c-1', name: 'Sarah Connor', role: 'case_manager' }, error: null },
  observed           = [],
} = {}) {
  return {
    _observed: observed,
    from(table) {
      if (table !== 'bd_account_contacts') throw new Error(`unexpected ${table}`);
      return {
        update(patch) {
          observed.push({ op: 'update', patch });
          return {
            // Two chain shapes: terminal `.eq().eq().neq()` for the
            // demote-other-primary path, and `.eq().select().single()`
            // for the row update.
            eq() { return this; },
            neq() { return Promise.resolve({ error: null }); },
            select() { return this; },
            single: () => Promise.resolve(updateResult),
          };
        },
      };
    },
  };
}

describe('updateContact', () => {
  it('rejects without supabase', async () => {
    const r = await updateContact(null, { contactId: 'c-1', draft: { name: 'X' } });
    expect(r.error).toBeTruthy();
  });

  it('rejects without a contact id', async () => {
    const stub = makeUpdateStub();
    const r = await updateContact(stub, { contactId: null, draft: { name: 'X' } });
    expect(r.error?.message).toMatch(/contact id/i);
    expect(stub._observed).toHaveLength(0);
  });

  it('rejects when name is blanked out (NOT NULL on the table)', async () => {
    const stub = makeUpdateStub();
    const r = await updateContact(stub, { contactId: 'c-1', draft: { name: '   ' } });
    expect(r.error).toBeTruthy();
    expect(stub._observed).toHaveLength(0);
  });

  it('rejects an unknown role', async () => {
    const stub = makeUpdateStub();
    const r = await updateContact(stub, {
      contactId: 'c-1',
      draft: { name: 'Sarah', role: 'archivist' },
    });
    expect(r.error).toBeTruthy();
    expect(stub._observed).toHaveLength(0);
  });

  it('rejects an obviously bad email', async () => {
    const stub = makeUpdateStub();
    const r = await updateContact(stub, {
      contactId: 'c-1',
      draft: { name: 'Sarah', email: 'not-an-email' },
    });
    expect(r.error).toBeTruthy();
    expect(stub._observed).toHaveLength(0);
  });

  it('writes the patch with whitespace-trimmed and null-on-empty fields', async () => {
    const observed = [];
    const stub = makeUpdateStub({ observed });
    await updateContact(stub, {
      contactId: 'c-1',
      draft: {
        name:         '  Sarah Connor ',
        title:        '  RN, BSN ',
        role:         'case_manager',
        email:        '   ',
        phone_mobile: '555-0001',
        phone_office: '',
        is_primary:   false,
      },
    });
    const updateOp = observed.find((o) => o.op === 'update');
    expect(updateOp.patch.name).toBe('Sarah Connor');
    expect(updateOp.patch.title).toBe('RN, BSN');
    expect(updateOp.patch.email).toBe(null);
    expect(updateOp.patch.phone_office).toBe(null);
    expect(updateOp.patch.is_primary).toBe(false);
    expect(updateOp.patch.role).toBe('case_manager');
    expect(typeof updateOp.patch.updated_at).toBe('string');
  });

  it('demotes other primaries when is_primary=true and account_id is provided', async () => {
    const observed = [];
    const stub = makeUpdateStub({ observed });
    await updateContact(stub, {
      contactId: 'c-1',
      draft: {
        name: 'Sarah Connor',
        is_primary: true,
        account_id: 'a-1',
      },
    });
    // Two `update` ops: the demote (is_primary=false) + the actual edit.
    const updates = observed.filter((o) => o.op === 'update');
    expect(updates.length).toBe(2);
    expect(updates[0].patch.is_primary).toBe(false);  // demote
    expect(updates[1].patch.is_primary).toBe(true);   // promote target
  });

  it('skips the demote when is_primary stays false', async () => {
    const observed = [];
    const stub = makeUpdateStub({ observed });
    await updateContact(stub, {
      contactId: 'c-1',
      draft: { name: 'Sarah', is_primary: false, account_id: 'a-1' },
    });
    const updates = observed.filter((o) => o.op === 'update');
    expect(updates.length).toBe(1);
  });
});

// ─── Account location update ───

function makeAccountLocationStub({
  updateResult = {
    data: { id: 'acc-1', address: '100 Main St', city: 'Irvine', state: 'CA', zip: '92614', lat: 33.65, lng: -117.74 },
    error: null,
  },
  observed     = [],
} = {}) {
  return {
    _observed: observed,
    from(table) {
      if (table !== 'bd_accounts') throw new Error(`unexpected ${table}`);
      return {
        update(patch) {
          observed.push({ op: 'update', patch });
          return {
            eq() { return this; },
            select() { return this; },
            single: () => Promise.resolve(updateResult),
          };
        },
      };
    },
  };
}

describe('validateAccountLocationDraft', () => {
  it('rejects null / non-object input', () => {
    expect(validateAccountLocationDraft(null).ok).toBe(false);
    expect(validateAccountLocationDraft('hi').ok).toBe(false);
  });

  it('rejects an empty draft', () => {
    expect(validateAccountLocationDraft({}).ok).toBe(false);
  });

  it('accepts a single address field', () => {
    expect(validateAccountLocationDraft({ address: '100 Main St' }).ok).toBe(true);
    expect(validateAccountLocationDraft({ city: 'Irvine' }).ok).toBe(true);
    expect(validateAccountLocationDraft({ state: 'CA' }).ok).toBe(true);
    expect(validateAccountLocationDraft({ zip: '92614' }).ok).toBe(true);
  });

  it('requires lat and lng to be paired', () => {
    expect(validateAccountLocationDraft({ lat: 33.65 }).ok).toBe(false);
    expect(validateAccountLocationDraft({ lng: -117.74 }).ok).toBe(false);
    expect(validateAccountLocationDraft({ lat: 33.65, lng: -117.74 }).ok).toBe(true);
  });

  it('permits explicit nulls so a bad pin can be cleared', () => {
    expect(validateAccountLocationDraft({ lat: null, lng: null }).ok).toBe(true);
  });

  it('rejects out-of-range latitude', () => {
    expect(validateAccountLocationDraft({ lat: 91, lng: 0 }).ok).toBe(false);
    expect(validateAccountLocationDraft({ lat: -91, lng: 0 }).ok).toBe(false);
  });

  it('rejects out-of-range longitude', () => {
    expect(validateAccountLocationDraft({ lat: 0, lng: 181 }).ok).toBe(false);
    expect(validateAccountLocationDraft({ lat: 0, lng: -181 }).ok).toBe(false);
  });

  it('rejects NaN lat or lng', () => {
    expect(validateAccountLocationDraft({ lat: NaN, lng: 0 }).ok).toBe(false);
    expect(validateAccountLocationDraft({ lat: 0, lng: NaN }).ok).toBe(false);
  });

  it('rejects absurdly long state', () => {
    expect(validateAccountLocationDraft({ state: 'x'.repeat(50) }).ok).toBe(false);
  });
});

describe('buildAccountLocationPatch', () => {
  it('only includes fields the caller actually passed', () => {
    const patch = buildAccountLocationPatch({ address: '100 Main St', city: 'Irvine' });
    expect(patch.address).toBe('100 Main St');
    expect(patch.city).toBe('Irvine');
    expect('state' in patch).toBe(false);
    expect('zip'   in patch).toBe(false);
    expect('lat'   in patch).toBe(false);
    expect('lng'   in patch).toBe(false);
    expect(typeof patch.updated_at).toBe('string');
  });

  it('trims whitespace and stores empty strings as null', () => {
    const patch = buildAccountLocationPatch({
      address: '  100 Main St  ',
      city:    '   ',
      state:   'CA',
      zip:     '',
    });
    expect(patch.address).toBe('100 Main St');
    expect(patch.city).toBe(null);
    expect(patch.state).toBe('CA');
    expect(patch.zip).toBe(null);
  });

  it('passes lat/lng through as a pair', () => {
    const patch = buildAccountLocationPatch({ lat: 33.65, lng: -117.74 });
    expect(patch.lat).toBe(33.65);
    expect(patch.lng).toBe(-117.74);
  });

  it('does not include lat/lng if only one was passed', () => {
    const patch = buildAccountLocationPatch({ lat: 33.65 });
    expect('lat' in patch).toBe(false);
    expect('lng' in patch).toBe(false);
  });
});

describe('updateAccountLocation', () => {
  it('rejects without supabase', async () => {
    const r = await updateAccountLocation(null, { accountId: 'a-1', draft: { address: '100 Main St' } });
    expect(r.error).toBeTruthy();
  });

  it('rejects without an account id', async () => {
    const stub = makeAccountLocationStub();
    const r = await updateAccountLocation(stub, { accountId: null, draft: { address: '100 Main St' } });
    expect(r.error?.message).toMatch(/account id/i);
    expect(stub._observed).toHaveLength(0);
  });

  it('rejects an invalid draft before hitting the network', async () => {
    const stub = makeAccountLocationStub();
    const r = await updateAccountLocation(stub, { accountId: 'a-1', draft: {} });
    expect(r.error).toBeTruthy();
    expect(stub._observed).toHaveLength(0);
  });

  it('writes a patch that only includes provided fields', async () => {
    const observed = [];
    const stub = makeAccountLocationStub({ observed });
    await updateAccountLocation(stub, {
      accountId: 'a-1',
      draft: { lat: 33.65, lng: -117.74 },
    });
    const updateOp = observed.find((o) => o.op === 'update');
    expect(updateOp.patch.lat).toBe(33.65);
    expect(updateOp.patch.lng).toBe(-117.74);
    expect('address' in updateOp.patch).toBe(false);
    expect('city'    in updateOp.patch).toBe(false);
  });

  it('surfaces the inserted row on success', async () => {
    const stub = makeAccountLocationStub();
    const r = await updateAccountLocation(stub, {
      accountId: 'a-1',
      draft: { address: '100 Main St', city: 'Irvine', state: 'CA', zip: '92614' },
    });
    expect(r.error).toBe(null);
    expect(r.data?.address).toBe('100 Main St');
  });

  it('surfaces supabase errors', async () => {
    const stub = makeAccountLocationStub({
      updateResult: { data: null, error: new Error('row level security') },
    });
    const r = await updateAccountLocation(stub, {
      accountId: 'a-1',
      draft: { address: '100 Main St' },
    });
    expect(r.error?.message).toMatch(/row level/i);
  });
});

// ─── Account creation ─────────────────────────────────────────────

const validFacilityAccountDraft = () => ({
  name: 'Hoag Hospital — Newport Beach',
  account_type: 'facility',
  facility_subtype: 'hospital',
  address: '1 Hoag Dr',
  city: 'Newport Beach',
  state: 'CA',
  zip: '92663',
  phone: '949-764-4624',
  website: 'hoag.org',
  notes: '',
  is_strategic_shared: false,
});

const validProfessionalAccountDraft = () => ({
  name: 'Sarah Connor, Esq.',
  account_type: 'professional',
  professional_subtype: 'attorney',
});

describe('ACCOUNT_TYPES / subtype domains', () => {
  it('matches the bd_accounts.account_type CHECK constraint', () => {
    expect(ACCOUNT_TYPES).toEqual(['facility', 'professional']);
  });
  it('matches the bd_accounts.facility_subtype CHECK constraint', () => {
    expect(FACILITY_SUBTYPES).toEqual([
      'hospital', 'snf', 'alf', 'independent_living',
      'memory_care', 'rehab', 'hospice', 'home_health', 'other',
    ]);
  });
  it('matches the bd_accounts.professional_subtype CHECK constraint', () => {
    expect(PROFESSIONAL_SUBTYPES).toEqual([
      'gcm', 'attorney', 'financial_planner',
      'physician', 'social_worker', 'other',
    ]);
  });
});

describe('validateAccountDraft', () => {
  it('accepts a valid facility draft', () => {
    expect(validateAccountDraft(validFacilityAccountDraft())).toEqual({ ok: true });
  });
  it('accepts a valid professional draft', () => {
    expect(validateAccountDraft(validProfessionalAccountDraft())).toEqual({ ok: true });
  });
  it('rejects null / non-object input', () => {
    expect(validateAccountDraft(null).ok).toBe(false);
    expect(validateAccountDraft('hi').ok).toBe(false);
  });
  it('requires a non-empty name', () => {
    expect(validateAccountDraft({ ...validFacilityAccountDraft(), name: '' }).ok).toBe(false);
    expect(validateAccountDraft({ ...validFacilityAccountDraft(), name: '   ' }).ok).toBe(false);
  });
  it('rejects an unknown account_type', () => {
    expect(validateAccountDraft({ ...validFacilityAccountDraft(), account_type: 'partner' }).ok).toBe(false);
  });
  it('requires a facility subtype when account_type=facility', () => {
    expect(validateAccountDraft({ ...validFacilityAccountDraft(), facility_subtype: '' }).ok).toBe(false);
  });
  it('rejects an unknown facility subtype', () => {
    expect(validateAccountDraft({ ...validFacilityAccountDraft(), facility_subtype: 'clinic' }).ok).toBe(false);
  });
  it('rejects a facility draft with a professional subtype set', () => {
    expect(validateAccountDraft({
      ...validFacilityAccountDraft(),
      professional_subtype: 'attorney',
    }).ok).toBe(false);
  });
  it('requires a professional subtype when account_type=professional', () => {
    expect(validateAccountDraft({ ...validProfessionalAccountDraft(), professional_subtype: '' }).ok).toBe(false);
  });
  it('rejects an unknown professional subtype', () => {
    expect(validateAccountDraft({ ...validProfessionalAccountDraft(), professional_subtype: 'dentist' }).ok).toBe(false);
  });
  it('rejects a professional draft with a facility subtype set', () => {
    expect(validateAccountDraft({
      ...validProfessionalAccountDraft(),
      facility_subtype: 'hospital',
    }).ok).toBe(false);
  });
  it('rejects a malformed website', () => {
    expect(validateAccountDraft({ ...validFacilityAccountDraft(), website: 'not a url' }).ok).toBe(false);
  });
  it('accepts a website with or without scheme', () => {
    expect(validateAccountDraft({ ...validFacilityAccountDraft(), website: 'https://hoag.org' }).ok).toBe(true);
    expect(validateAccountDraft({ ...validFacilityAccountDraft(), website: 'hoag.org' }).ok).toBe(true);
  });
});

describe('buildAccountRow', () => {
  it('shapes the row for bd_accounts insert (facility)', () => {
    const row = buildAccountRow(validFacilityAccountDraft(), 'org-1', 'Sasha');
    expect(row).toMatchObject({
      org_id: 'org-1',
      name: 'Hoag Hospital — Newport Beach',
      account_type: 'facility',
      facility_subtype: 'hospital',
      professional_subtype: null,
      city: 'Newport Beach',
      state: 'CA',
      zip: '92663',
      source: 'manual',
      is_active: true,
      is_strategic_shared: false,
      created_by: 'Sasha',
    });
  });
  it('clears the wrong-axis subtype on a professional row', () => {
    const row = buildAccountRow(
      { ...validProfessionalAccountDraft(), facility_subtype: 'hospital' },
      'org-1', 'Sasha',
    );
    expect(row.facility_subtype).toBe(null);
    expect(row.professional_subtype).toBe('attorney');
  });
  it('trims strings and nulls empties', () => {
    const row = buildAccountRow({
      ...validFacilityAccountDraft(),
      name:  '  Hoag  ',
      city:  '  ',
      phone: '',
      notes: '',
    }, 'org-1', 'Sasha');
    expect(row.name).toBe('Hoag');
    expect(row.city).toBe(null);
    expect(row.phone).toBe(null);
    expect(row.notes).toBe(null);
  });
});

// Stub that supports the bd_accounts INSERT + dupcheck SELECT paths.
function makeAccountCreateStub({
  dupResult    = { data: [], error: null },
  insertResult = { data: { id: 'acc-new', name: 'Hoag Hospital — Newport Beach', account_type: 'facility', facility_subtype: 'hospital', city: 'Newport Beach', state: 'CA' }, error: null },
  observed     = [],
} = {}) {
  return {
    _observed: observed,
    from(table) {
      if (table !== 'bd_accounts') throw new Error(`unexpected ${table}`);
      return {
        select() {
          // Used by findAccountDuplicates: select().ilike().limit() or .eq().ilike().limit()
          return {
            ilike() { return this; },
            eq()    { return this; },
            limit:  () => Promise.resolve(dupResult),
            // Used by the INSERT chain: .insert().select().single()
            single: () => Promise.resolve(insertResult),
          };
        },
        insert(row) {
          observed.push({ op: 'insert', row });
          return {
            select() { return this; },
            single:  () => Promise.resolve(insertResult),
          };
        },
      };
    },
  };
}

describe('findAccountDuplicates', () => {
  it('returns rows from supabase when a match exists', async () => {
    const stub = makeAccountCreateStub({
      dupResult: { data: [{ id: 'acc-1', name: 'Hoag Hospital', city: 'Irvine' }], error: null },
    });
    const r = await findAccountDuplicates(stub, { orgId: 'org-1', name: 'Hoag Hospital' });
    expect(r.error).toBe(null);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].id).toBe('acc-1');
  });
  it('returns an empty list when name is blank', async () => {
    const stub = makeAccountCreateStub();
    const r = await findAccountDuplicates(stub, { orgId: 'org-1', name: '   ' });
    expect(r.data).toEqual([]);
  });
  it('surfaces supabase errors', async () => {
    const stub = makeAccountCreateStub({ dupResult: { data: null, error: new Error('rls') } });
    const r = await findAccountDuplicates(stub, { orgId: 'org-1', name: 'Hoag' });
    expect(r.error?.message).toMatch(/rls/i);
    expect(r.data).toEqual([]);
  });
});

describe('createAccount', () => {
  it('rejects when supabase client is missing', async () => {
    const r = await createAccount(null, { orgId: 'o', draft: validFacilityAccountDraft(), createdBy: 'u' });
    expect(r.error).toBeTruthy();
  });

  it('rejects when validation fails', async () => {
    const stub = makeAccountCreateStub();
    const r = await createAccount(stub, { orgId: 'o', draft: { ...validFacilityAccountDraft(), name: '' }, createdBy: 'u' });
    expect(r.error).toBeTruthy();
    expect(stub._observed).toHaveLength(0);
  });

  it('rejects without org_id', async () => {
    const stub = makeAccountCreateStub();
    const r = await createAccount(stub, { orgId: null, draft: validFacilityAccountDraft(), createdBy: 'u' });
    expect(r.error?.message).toMatch(/org/i);
    expect(stub._observed).toHaveLength(0);
  });

  it('returns duplicate=true and the matching rows when a same-name account exists', async () => {
    const stub = makeAccountCreateStub({
      dupResult: { data: [{ id: 'acc-1', name: 'Hoag Hospital', city: 'Irvine' }], error: null },
    });
    const r = await createAccount(stub, { orgId: 'org-1', draft: validFacilityAccountDraft(), createdBy: 'Sasha' });
    expect(r.error).toBe(null);
    expect(r.duplicate).toBe(true);
    expect(r.duplicates).toHaveLength(1);
    expect(stub._observed.find((o) => o.op === 'insert')).toBeUndefined();
  });

  it('skips the duplicate check when force=true', async () => {
    const stub = makeAccountCreateStub({
      dupResult: { data: [{ id: 'acc-1', name: 'Hoag Hospital' }], error: null },
    });
    const r = await createAccount(stub, {
      orgId: 'org-1', draft: validFacilityAccountDraft(), createdBy: 'Sasha', force: true,
    });
    expect(r.error).toBe(null);
    expect(r.duplicate).toBe(false);
    expect(r.data?.id).toBe('acc-new');
    expect(stub._observed.find((o) => o.op === 'insert')).toBeTruthy();
  });

  it('inserts a fresh account when no duplicate exists', async () => {
    const stub = makeAccountCreateStub();
    const r = await createAccount(stub, { orgId: 'org-1', draft: validFacilityAccountDraft(), createdBy: 'Sasha' });
    expect(r.error).toBe(null);
    expect(r.duplicate).toBe(false);
    expect(r.data?.id).toBe('acc-new');
    const insertOp = stub._observed.find((o) => o.op === 'insert');
    expect(insertOp.row).toMatchObject({
      org_id: 'org-1',
      name: 'Hoag Hospital — Newport Beach',
      account_type: 'facility',
      facility_subtype: 'hospital',
      source: 'manual',
      is_active: true,
      created_by: 'Sasha',
    });
  });
});

// Composite stub that handles bd_accounts (insert + dup check) AND
// bd_account_contacts (dup check + insert) so we can exercise
// createAccountWithContacts end-to-end.
function makeAccountWithContactsStub({
  accountInsertResult = { data: { id: 'acc-new', name: 'Hoag Hospital — Newport Beach' }, error: null },
  contactDupResult    = { data: [], error: null },
  contactInsertResult = null,
  accountDupResult    = { data: [], error: null },
  observed            = [],
} = {}) {
  return {
    _observed: observed,
    from(table) {
      if (table === 'bd_accounts') {
        return {
          select() {
            return {
              ilike() { return this; },
              eq()    { return this; },
              limit:  () => Promise.resolve(accountDupResult),
              single: () => Promise.resolve(accountInsertResult),
            };
          },
          insert(row) {
            observed.push({ table, op: 'insert', row });
            return {
              select() { return this; },
              single:  () => Promise.resolve(accountInsertResult),
            };
          },
        };
      }
      if (table === 'bd_account_contacts') {
        return {
          select() {
            return {
              eq()   { return this; },
              ilike() { return this; },
              limit: () => Promise.resolve(contactDupResult),
              single: () => Promise.resolve(contactInsertResult ?? { data: null, error: null }),
            };
          },
          insert(row) {
            observed.push({ table, op: 'insert', row });
            return {
              select() { return this; },
              single:  () => Promise.resolve(contactInsertResult ?? {
                data: { id: `c-${row.name.replace(/\s+/g, '-').toLowerCase()}`, ...row },
                error: null,
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

describe('createAccountWithContacts', () => {
  it('creates the account and zero contacts when none provided', async () => {
    const stub = makeAccountWithContactsStub();
    const r = await createAccountWithContacts(stub, {
      orgId: 'org-1',
      draft: validFacilityAccountDraft(),
      contactDrafts: [],
      createdBy: 'Sasha',
    });
    expect(r.error).toBe(null);
    expect(r.duplicate).toBe(false);
    expect(r.data?.id).toBe('acc-new');
    expect(r.contacts).toHaveLength(0);
    expect(r.contactErrors).toHaveLength(0);
    const accountInserts = stub._observed.filter((o) => o.table === 'bd_accounts' && o.op === 'insert');
    expect(accountInserts).toHaveLength(1);
  });

  it('inserts each named contact and skips blank rows', async () => {
    const stub = makeAccountWithContactsStub();
    const r = await createAccountWithContacts(stub, {
      orgId: 'org-1',
      draft: validFacilityAccountDraft(),
      contactDrafts: [
        { name: 'Sarah Connor', role: 'case_manager', email: 's@hoag.org' },
        { name: '   ' }, // skipped
        { name: 'John Doe', role: null },
      ],
      createdBy: 'Sasha',
    });
    expect(r.error).toBe(null);
    expect(r.contacts).toHaveLength(2);
    const contactInserts = stub._observed.filter((o) => o.table === 'bd_account_contacts' && o.op === 'insert');
    expect(contactInserts).toHaveLength(2);
    expect(contactInserts[0].row.account_id).toBe('acc-new');
    expect(contactInserts[0].row.name).toBe('Sarah Connor');
    expect(contactInserts[1].row.name).toBe('John Doe');
  });

  it('keeps only the first is_primary contact primary', async () => {
    const stub = makeAccountWithContactsStub();
    await createAccountWithContacts(stub, {
      orgId: 'org-1',
      draft: validFacilityAccountDraft(),
      contactDrafts: [
        { name: 'A', is_primary: true },
        { name: 'B', is_primary: true },
        { name: 'C', is_primary: true },
      ],
      createdBy: 'Sasha',
    });
    const contactInserts = stub._observed.filter((o) => o.table === 'bd_account_contacts' && o.op === 'insert');
    expect(contactInserts.map((o) => o.row.is_primary)).toEqual([true, false, false]);
  });

  it('does not insert contacts when the account creation hits a duplicate', async () => {
    const stub = makeAccountWithContactsStub({
      accountDupResult: { data: [{ id: 'acc-existing', name: 'Hoag Hospital' }], error: null },
    });
    const r = await createAccountWithContacts(stub, {
      orgId: 'org-1',
      draft: validFacilityAccountDraft(),
      contactDrafts: [{ name: 'Sarah Connor' }],
      createdBy: 'Sasha',
    });
    expect(r.duplicate).toBe(true);
    expect(r.contacts).toHaveLength(0);
    const contactInserts = stub._observed.filter((o) => o.table === 'bd_account_contacts' && o.op === 'insert');
    expect(contactInserts).toHaveLength(0);
  });

  it('continues past a failed contact and surfaces it in contactErrors', async () => {
    // Make the *second* contact fail by hijacking the stub at runtime.
    let callCount = 0;
    const observed = [];
    const stub = {
      _observed: observed,
      from(table) {
        if (table === 'bd_accounts') {
          return {
            select() {
              return {
                ilike() { return this; },
                eq()    { return this; },
                limit:  () => Promise.resolve({ data: [], error: null }),
                single: () => Promise.resolve({ data: { id: 'acc-new', name: 'H' }, error: null }),
              };
            },
            insert(row) {
              observed.push({ table, op: 'insert', row });
              return {
                select() { return this; },
                single:  () => Promise.resolve({ data: { id: 'acc-new', name: 'H' }, error: null }),
              };
            },
          };
        }
        if (table === 'bd_account_contacts') {
          return {
            select() {
              return {
                eq()   { return this; },
                ilike() { return this; },
                limit: () => Promise.resolve({ data: [], error: null }),
              };
            },
            insert(row) {
              observed.push({ table, op: 'insert', row });
              callCount += 1;
              const isSecond = callCount === 2;
              return {
                select() { return this; },
                single:  () => Promise.resolve(
                  isSecond
                    ? { data: null, error: new Error('contact blocked') }
                    : { data: { id: `c-${callCount}`, ...row }, error: null },
                ),
              };
            },
          };
        }
        throw new Error(`unexpected ${table}`);
      },
    };
    const r = await createAccountWithContacts(stub, {
      orgId: 'org-1',
      draft: validFacilityAccountDraft(),
      contactDrafts: [
        { name: 'First' },
        { name: 'Second' },
        { name: 'Third' },
      ],
      createdBy: 'Sasha',
    });
    expect(r.error).toBe(null);
    expect(r.contacts).toHaveLength(2);
    expect(r.contactErrors).toHaveLength(1);
    expect(r.contactErrors[0].name).toBe('Second');
  });
});

// ─── Account update ───

describe('buildAccountUpdatePatch', () => {
  it('shapes the patch and stamps updated_at (facility)', () => {
    const patch = buildAccountUpdatePatch(validFacilityAccountDraft());
    expect(patch).toMatchObject({
      name: 'Hoag Hospital — Newport Beach',
      account_type: 'facility',
      facility_subtype: 'hospital',
      professional_subtype: null,
      city: 'Newport Beach',
      state: 'CA',
      zip: '92663',
      is_strategic_shared: false,
    });
    expect(typeof patch.updated_at).toBe('string');
  });

  it('omits insert-only columns (no org_id / source / is_active / created_by)', () => {
    const patch = buildAccountUpdatePatch(validFacilityAccountDraft());
    expect(patch).not.toHaveProperty('org_id');
    expect(patch).not.toHaveProperty('source');
    expect(patch).not.toHaveProperty('is_active');
    expect(patch).not.toHaveProperty('created_by');
  });

  it('clears the wrong-axis subtype for a professional edit', () => {
    const patch = buildAccountUpdatePatch({
      ...validProfessionalAccountDraft(),
      facility_subtype: 'hospital',
    });
    expect(patch.facility_subtype).toBe(null);
    expect(patch.professional_subtype).toBe('attorney');
  });

  it('trims strings and nulls empties', () => {
    const patch = buildAccountUpdatePatch({
      ...validFacilityAccountDraft(),
      name:    '  Hoag  ',
      city:    '  ',
      phone:   '',
      website: '',
      notes:   '   ',
    });
    expect(patch.name).toBe('Hoag');
    expect(patch.city).toBe(null);
    expect(patch.phone).toBe(null);
    expect(patch.website).toBe(null);
    expect(patch.notes).toBe(null);
  });
});

describe('updateAccount', () => {
  it('rejects without supabase', async () => {
    const r = await updateAccount(null, { accountId: 'a-1', draft: validFacilityAccountDraft() });
    expect(r.error).toBeTruthy();
  });

  it('rejects without an account id', async () => {
    const stub = makeAccountLocationStub();
    const r = await updateAccount(stub, { accountId: null, draft: validFacilityAccountDraft() });
    expect(r.error?.message).toMatch(/account id/i);
    expect(stub._observed).toHaveLength(0);
  });

  it('rejects an invalid draft (no write attempted)', async () => {
    const stub = makeAccountLocationStub();
    const r = await updateAccount(stub, {
      accountId: 'a-1',
      draft: { ...validFacilityAccountDraft(), account_type: 'partner' },
    });
    expect(r.error).toBeTruthy();
    expect(stub._observed).toHaveLength(0);
  });

  it('writes the patch and returns the updated row', async () => {
    const observed = [];
    const stub = makeAccountLocationStub({
      updateResult: {
        data: { id: 'a-1', name: 'Hoag Hospital — Newport Beach', account_type: 'facility' },
        error: null,
      },
      observed,
    });
    const r = await updateAccount(stub, { accountId: 'a-1', draft: validFacilityAccountDraft() });
    expect(r.error).toBe(null);
    expect(r.data?.id).toBe('a-1');
    const updateOp = observed.find((o) => o.op === 'update');
    expect(updateOp.patch.name).toBe('Hoag Hospital — Newport Beach');
    expect(updateOp.patch.account_type).toBe('facility');
    expect(typeof updateOp.patch.updated_at).toBe('string');
  });
});
