// BD write-side helpers. Pure validators + thin Supabase wrappers
// for the two write surfaces: log an activity (PR #4) and intake a
// referral (PR #5). Kept separate from React so the validation logic
// can be unit-tested against a stub client.

// User-facing buttons in the Quick Capture form (subset of the full
// CHECK domain — the rep doesn't directly tap "sms" or
// "referral_received" since those are recorded by other flows).
export const QUICK_CAPTURE_TYPES = ['visit', 'call', 'email', 'drop_off', 'note'];
export const QUICK_CAPTURE_LABELS = {
  visit:    'Visit',
  call:     'Call',
  email:    'Email',
  drop_off: 'Drop-off',
  note:     'Note',
};

// Full bd_activities.activity_type CHECK constraint domain. Used by
// validateActivityDraft so internal callers (e.g. createReferral
// logging a 'referral_received' row) pass validation.
export const ACTIVITY_TYPES_ALL = [
  'visit', 'call', 'email', 'sms', 'drop_off', 'event', 'referral_received', 'note',
];

export const SPEND_CATEGORIES = ['meal', 'gift', 'swag', 'event', 'other'];

// Parses user input ("$25", "25", "25.50", "") to a non-negative
// integer count of cents. Returns 0 for empty/invalid input.
export function parseDollarsToCents(input) {
  if (input === null || input === undefined) return 0;
  const cleaned = String(input).replace(/[^0-9.]/g, '');
  if (!cleaned) return 0;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return 0;
  return Math.round(dollars * 100);
}

// Validates a quick-capture form before submit. Returns either
// { ok: true } or { ok: false, error }. Centralised so the form,
// the hook, and tests all share the same rules.
export function validateActivityDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'Missing form data.' };
  }
  if (!ACTIVITY_TYPES_ALL.includes(draft.activity_type)) {
    return { ok: false, error: 'Pick an activity type.' };
  }
  if (!draft.account_id) {
    return { ok: false, error: 'Pick an account.' };
  }
  if (!draft.occurred_at) {
    return { ok: false, error: 'Set a date and time.' };
  }
  const t = new Date(draft.occurred_at).getTime();
  if (Number.isNaN(t)) {
    return { ok: false, error: 'That date and time is not valid.' };
  }
  if (typeof draft.spend_cents !== 'number' || draft.spend_cents < 0) {
    return { ok: false, error: 'Spend must be zero or positive.' };
  }
  if (draft.spend_cents > 0 && !SPEND_CATEGORIES.includes(draft.spend_category)) {
    return { ok: false, error: 'Pick a spend category.' };
  }
  return { ok: true };
}

// Builds the row passed to bd_activities.insert. Decoupled so the
// shape stays in one place.
export function buildActivityRow(draft, orgId, createdBy) {
  return {
    org_id:           orgId,
    account_id:       draft.account_id,
    contact_id:       draft.contact_id ?? null,
    activity_type:    draft.activity_type,
    occurred_at:      new Date(draft.occurred_at).toISOString(),
    duration_minutes: draft.duration_minutes ?? null,
    spend_cents:      draft.spend_cents ?? 0,
    spend_category:   draft.spend_cents > 0 ? (draft.spend_category ?? null) : null,
    notes:            draft.notes?.trim() ? draft.notes.trim() : null,
    gps_lat:          draft.gps_lat ?? null,
    gps_lng:          draft.gps_lng ?? null,
    source:           'manual',
    created_by:       createdBy ?? null,
  };
}

// Inserts the activity, then bumps the parent account's
// last_activity_at if the new occurred_at is newer than what's there.
// Returns { data, error } shaped like supabase-js. There is no DB
// trigger that maintains last_activity_at — we maintain it
// explicitly so the cold-account heuristic stays accurate after a
// log.
export async function insertActivity(supabase, { orgId, draft, createdBy }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  const validation = validateActivityDraft(draft);
  if (!validation.ok) return { data: null, error: new Error(validation.error) };
  if (!orgId) return { data: null, error: new Error('Missing org_id from session — sign out and back in.') };

  const row = buildActivityRow(draft, orgId, createdBy);
  const insertRes = await supabase
    .from('bd_activities')
    .insert(row)
    .select('id, account_id, occurred_at, activity_type')
    .single();
  if (insertRes.error) return { data: null, error: insertRes.error };

  // Bump last_activity_at on the account. Best-effort — if this
  // update fails the activity still wrote successfully, so we don't
  // surface the error to the user.
  try {
    const acctRes = await supabase
      .from('bd_accounts')
      .select('last_activity_at')
      .eq('id', row.account_id)
      .single();
    const current = acctRes?.data?.last_activity_at;
    if (!current || new Date(row.occurred_at).getTime() > new Date(current).getTime()) {
      await supabase
        .from('bd_accounts')
        .update({ last_activity_at: row.occurred_at })
        .eq('id', row.account_id);
    }
  } catch (e) {
    console.warn('last_activity_at bump failed:', e);
  }

  return { data: insertRes.data, error: null };
}

// ─── Referral intake (PR #5) ─────────────────────────────────────

export const REFERRAL_LOSS_REASONS = [
  'insurance_denied',
  'chose_other_agency',
  'patient_passed',
  'did_not_qualify',
  'lost_contact',
  'cost',
  'other',
];

// Splits a free-text "first last" name into { first_name, last_name }.
// One-token names land in first_name; everything after the first
// token joins as last_name. Robust to extra whitespace and missing
// surnames.
export function splitName(input) {
  if (!input || typeof input !== 'string') return { first_name: '', last_name: '' };
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first_name: '', last_name: '' };
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

export function validateReferralDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'Missing form data.' };
  }
  if (!draft.account_id) {
    return { ok: false, error: 'Pick the referring account.' };
  }
  if (!draft.prospective_name || !draft.prospective_name.trim()) {
    return { ok: false, error: 'Enter the prospective client’s name.' };
  }
  if (!draft.referred_at) {
    return { ok: false, error: 'Set the referral date.' };
  }
  const t = new Date(draft.referred_at).getTime();
  if (Number.isNaN(t)) {
    return { ok: false, error: 'That referral date is not valid.' };
  }
  return { ok: true };
}

// Generates a short, urlsafe text id for clients.id. We prefer
// crypto.randomUUID when available (browsers + modern Node); falls
// back to a timestamp+random string otherwise so unit tests don't
// need to polyfill.
export function generateClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// Builds the clients.notes seed entry. Matches the existing
// shape used elsewhere in the portal: { text, type, timestamp,
// author }. Stored as a single-element JSON array.
function buildSeedNotesArray({ accountName, contactName, prospectiveNotes, createdBy }) {
  const lines = [
    `Referred from ${accountName}${contactName ? ` (${contactName})` : ''}.`,
  ];
  if (prospectiveNotes && prospectiveNotes.trim()) {
    lines.push(prospectiveNotes.trim());
  }
  return [{
    text: lines.join('\n'),
    type: 'system',
    timestamp: new Date().toISOString(),
    author: createdBy || 'system:bd-referral',
  }];
}

// Atomically (best-effort) creates a clients lead, a bd_referrals row
// linking that client to the referring account/contact, and a
// bd_activities entry of type 'referral_received' so the timeline +
// last_activity_at reflect the referral. Returns { data: { client,
// referral }, error } shaped like the other helpers.
export async function createReferral(supabase, { orgId, draft, createdBy, accountName, contactName }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  const validation = validateReferralDraft(draft);
  if (!validation.ok) return { data: null, error: new Error(validation.error) };
  if (!orgId) return { data: null, error: new Error('Missing org_id from session — sign out and back in.') };

  const referredAtIso = new Date(draft.referred_at).toISOString();
  const { first_name, last_name } = splitName(draft.prospective_name);

  // 1) Insert the client lead.
  const clientId = draft.client_id ?? generateClientId();
  const clientRow = {
    id: clientId,
    org_id: orgId,
    first_name,
    last_name,
    phone: (draft.prospective_phone ?? '').trim(),
    email: '',
    referral_source: accountName ?? '',
    phase: 'new_lead',
    notes: buildSeedNotesArray({
      accountName: accountName ?? 'a referring account',
      contactName,
      prospectiveNotes: draft.prospective_notes,
      createdBy,
    }),
  };
  const clientRes = await supabase
    .from('clients')
    .insert(clientRow)
    .select('id, first_name, last_name')
    .single();
  if (clientRes.error) return { data: null, error: clientRes.error };

  // 2) Insert the bd_referrals row linking client → account.
  const referralRow = {
    org_id:             orgId,
    account_id:         draft.account_id,
    contact_id:         draft.contact_id ?? null,
    client_id:          clientId,
    referred_at:        referredAtIso,
    prospective_name:   draft.prospective_name.trim(),
    prospective_phone:  draft.prospective_phone?.trim() || null,
    prospective_notes:  draft.prospective_notes?.trim() || null,
    status:             'new',
    assigned_to:        'bd_rep',
    created_by:         createdBy ?? null,
  };
  const referralRes = await supabase
    .from('bd_referrals')
    .insert(referralRow)
    .select('id, account_id, contact_id, client_id, status')
    .single();
  if (referralRes.error) {
    // Roll back the client we just created so a partial referral
    // doesn't leave an orphan lead in the pipeline.
    try { await supabase.from('clients').delete().eq('id', clientId); }
    catch (e) { console.warn('client rollback failed:', e); }
    return { data: null, error: referralRes.error };
  }

  // 3) Best-effort: log a bd_activities row of type 'referral_received'
  //    so the activity timeline + last_activity_at reflect this. If it
  //    fails we don't surface — the referral itself succeeded.
  try {
    await insertActivity(supabase, {
      orgId,
      draft: {
        activity_type: 'referral_received',
        account_id:    draft.account_id,
        contact_id:    draft.contact_id ?? null,
        occurred_at:   referredAtIso,
        notes:         `Referral: ${draft.prospective_name.trim()}${draft.prospective_phone ? ` (${draft.prospective_phone.trim()})` : ''}`,
        spend_cents:   0,
      },
      createdBy,
    });
  } catch (e) {
    console.warn('referral activity log failed:', e);
  }

  return {
    data: { client: clientRes.data, referral: referralRes.data },
    error: null,
  };
}

// ─── Account location update ───────────────────────────────────
//
// Lets the rep fill in (or correct) the structured address on an
// existing account, and optionally pin its lat/lng. Used by:
//   - AccountProfile's "+ Add address" inline form (manual entry)
//   - QuickCapture's "save this location" prompt after a visit log
//     (passes the device GPS coordinate into lat/lng)
//
// Returns { data, error } shaped like the other helpers. All fields
// are optional individually — the caller passes only the columns it
// wants to set, and absent keys are left untouched.

export function validateAccountLocationDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'Missing form data.' };
  }
  const hasAnyField =
    Object.prototype.hasOwnProperty.call(draft, 'address') ||
    Object.prototype.hasOwnProperty.call(draft, 'city') ||
    Object.prototype.hasOwnProperty.call(draft, 'state') ||
    Object.prototype.hasOwnProperty.call(draft, 'zip') ||
    (Object.prototype.hasOwnProperty.call(draft, 'lat') &&
     Object.prototype.hasOwnProperty.call(draft, 'lng'));
  if (!hasAnyField) {
    return { ok: false, error: 'Provide at least one address field or a lat/lng pair.' };
  }
  if (Object.prototype.hasOwnProperty.call(draft, 'lat') ||
      Object.prototype.hasOwnProperty.call(draft, 'lng')) {
    const { lat, lng } = draft;
    // Permit explicit nulls to clear a bad pin, but if either is a
    // number both must be valid numbers in range.
    const latSet = lat !== null && lat !== undefined;
    const lngSet = lng !== null && lng !== undefined;
    if (latSet !== lngSet) {
      return { ok: false, error: 'lat and lng must be set together.' };
    }
    if (latSet) {
      if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
        return { ok: false, error: 'Latitude is out of range.' };
      }
      if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return { ok: false, error: 'Longitude is out of range.' };
      }
    }
  }
  if (draft.state !== undefined && draft.state !== null && String(draft.state).trim().length > 32) {
    return { ok: false, error: 'State value is too long.' };
  }
  return { ok: true };
}

// Builds the partial UPDATE payload. Skips keys the caller didn't
// pass so we never blank a column unintentionally. Trims string
// fields to null when empty so we don't write '' into the DB.
export function buildAccountLocationPatch(draft) {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(draft, 'address')) {
    const v = draft.address?.trim?.() ?? null;
    patch.address = v || null;
  }
  if (Object.prototype.hasOwnProperty.call(draft, 'city')) {
    const v = draft.city?.trim?.() ?? null;
    patch.city = v || null;
  }
  if (Object.prototype.hasOwnProperty.call(draft, 'state')) {
    const v = draft.state?.trim?.() ?? null;
    patch.state = v || null;
  }
  if (Object.prototype.hasOwnProperty.call(draft, 'zip')) {
    const v = draft.zip?.trim?.() ?? null;
    patch.zip = v || null;
  }
  if (Object.prototype.hasOwnProperty.call(draft, 'lat') &&
      Object.prototype.hasOwnProperty.call(draft, 'lng')) {
    patch.lat = draft.lat ?? null;
    patch.lng = draft.lng ?? null;
  }
  patch.updated_at = new Date().toISOString();
  return patch;
}

export async function updateAccountLocation(supabase, { accountId, draft }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!accountId) return { data: null, error: new Error('Missing account id.') };
  const validation = validateAccountLocationDraft(draft);
  if (!validation.ok) return { data: null, error: new Error(validation.error) };

  const patch = buildAccountLocationPatch(draft);
  const res = await supabase
    .from('bd_accounts')
    .update(patch)
    .eq('id', accountId)
    .select('id, address, city, state, zip, lat, lng')
    .single();
  if (res.error) return { data: null, error: res.error };
  return { data: res.data, error: null };
}

// ─── Contact creation (PR #10 — business-card OCR) ──────────────

// bd_account_contacts.role CHECK constraint domain.
export const CONTACT_ROLES = [
  'discharge_planner',
  'case_manager',
  'social_worker',
  'admissions',
  'ed_director',
  'administrator',
  'principal',
  'physician',
  'gcm',
  'attorney',
  'financial_planner',
  'office_manager',
  'other',
];

export const CONTACT_ROLE_LABELS = {
  discharge_planner:  'Discharge planner',
  case_manager:       'Case manager',
  social_worker:      'Social worker',
  admissions:         'Admissions',
  ed_director:        'ED director',
  administrator:      'Administrator',
  principal:          'Principal',
  physician:          'Physician',
  gcm:                'Geriatric care manager',
  attorney:           'Attorney',
  financial_planner:  'Financial planner',
  office_manager:     'Office manager',
  other:              'Other',
};

// Coerces an arbitrary role string to a CHECK-domain value or null.
// Tolerant: accepts the bucket key, the human label, leading/trailing
// whitespace, and case variants. Anything else → null.
export function normalizeContactRole(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (CONTACT_ROLES.includes(s)) return s;
  // Try matching against the human labels too (case-insensitive).
  for (const [key, label] of Object.entries(CONTACT_ROLE_LABELS)) {
    if (label.toLowerCase() === s) return key;
  }
  return null;
}

export function validateContactDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'Missing form data.' };
  }
  if (!draft.account_id) {
    return { ok: false, error: 'Pick an account.' };
  }
  if (!draft.name || !draft.name.trim()) {
    return { ok: false, error: 'Enter the contact’s name.' };
  }
  if (draft.role !== null && draft.role !== undefined && draft.role !== '' &&
      !CONTACT_ROLES.includes(draft.role)) {
    return { ok: false, error: 'Invalid role — pick from the dropdown.' };
  }
  const trimmedEmail = draft.email?.trim();
  if (trimmedEmail && !trimmedEmail.includes('@')) {
    return { ok: false, error: 'Email looks invalid.' };
  }
  return { ok: true };
}

// Inserts a bd_account_contacts row, deduping case-insensitively
// against existing contacts on the same account by name. Returns
// { data, error } shaped like the other helpers.
export async function createContact(supabase, { orgId, draft, createdBy }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  const validation = validateContactDraft(draft);
  if (!validation.ok) return { data: null, error: new Error(validation.error) };
  if (!orgId) return { data: null, error: new Error('Missing org_id from session — sign out and back in.') };

  // Pre-check for an existing contact with the same case-insensitive
  // name on this account so we don't create duplicates from a re-take.
  const cleanName = draft.name.trim();
  const existingRes = await supabase
    .from('bd_account_contacts')
    .select('id, name, role, title, email, phone_mobile, phone_office')
    .eq('account_id', draft.account_id)
    .ilike('name', cleanName)
    .limit(1);
  if (existingRes.error) return { data: null, error: existingRes.error };
  if ((existingRes.data ?? []).length > 0) {
    return {
      data: { existing: existingRes.data[0], created: null },
      error: null,
      duplicate: true,
    };
  }

  const row = {
    org_id:        orgId,
    account_id:    draft.account_id,
    name:          cleanName,
    title:         draft.title?.trim() || null,
    role:          draft.role || null,
    email:         draft.email?.trim() || null,
    phone_mobile:  draft.phone_mobile?.trim() || null,
    phone_office:  draft.phone_office?.trim() || null,
    notes:         draft.notes?.trim() || null,
    is_primary:    Boolean(draft.is_primary),
    created_by:    createdBy ?? null,
  };

  const insertRes = await supabase
    .from('bd_account_contacts')
    .insert(row)
    .select('id, name, role, title, email, phone_mobile, phone_office, is_primary')
    .single();
  if (insertRes.error) return { data: null, error: insertRes.error };

  return {
    data: { existing: null, created: insertRes.data },
    error: null,
    duplicate: false,
  };
}

// ─── Contact update ─────────────────────────────────────────────
//
// Updates a single bd_account_contacts row. Same validation rules as
// createContact (name required, role must be in the CHECK domain,
// email shape sanity check) so the rep gets the same guardrails
// whether she's adding or editing.

export async function updateContact(supabase, { contactId, draft }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!contactId) return { data: null, error: new Error('Missing contact id.') };

  // Reuse the create validator — fields that aren't touched by an
  // edit (account_id) still need to satisfy the schema, so we synth
  // an account_id of "*" just to pass the truthiness check; the
  // UPDATE itself never touches the column.
  const validation = validateContactDraft({ ...draft, account_id: draft.account_id ?? '*' });
  if (!validation.ok) return { data: null, error: new Error(validation.error) };

  const patch = {
    name:         draft.name?.trim() || null,
    title:        draft.title?.trim()         ?? null,
    role:         draft.role || null,
    email:        draft.email?.trim()         || null,
    phone_mobile: draft.phone_mobile?.trim()  || null,
    phone_office: draft.phone_office?.trim()  || null,
    notes:        draft.notes?.trim()         || null,
    is_primary:   Boolean(draft.is_primary),
    updated_at:   new Date().toISOString(),
  };
  // Don't allow blanking the name — name is NOT NULL on the table.
  if (!patch.name) {
    return { data: null, error: new Error('Name cannot be empty.') };
  }

  // If is_primary is being set to true, demote any other primary
  // contact on the same account first so we don't end up with
  // multiple "primary" rows. Best-effort — failure here doesn't
  // surface to the user.
  if (patch.is_primary && draft.account_id) {
    try {
      await supabase
        .from('bd_account_contacts')
        .update({ is_primary: false })
        .eq('account_id', draft.account_id)
        .eq('is_primary', true)
        .neq('id', contactId);
    } catch (e) {
      console.warn('demote-other-primary failed:', e);
    }
  }

  const updateRes = await supabase
    .from('bd_account_contacts')
    .update(patch)
    .eq('id', contactId)
    .select('id, name, role, title, email, phone_mobile, phone_office, is_primary, notes')
    .single();
  if (updateRes.error) return { data: null, error: updateRes.error };

  return { data: updateRes.data, error: null };
}

// ─── Account creation ──────────────────────────────────────────
//
// Backs the "+ Add Account" flow on the Accounts list. Lets a rep
// stand up a brand-new bd_accounts row (and optionally seed 0..N
// contacts in the same flow) without having to wait for the next
// research-import batch. Source is stamped as 'manual' so we can
// distinguish rep-created accounts from imports later.

// bd_accounts.account_type CHECK constraint domain.
export const ACCOUNT_TYPES = ['facility', 'professional'];

export const ACCOUNT_TYPE_LABELS = {
  facility:     'Facility',
  professional: 'Professional',
};

// bd_accounts.facility_subtype CHECK constraint domain.
export const FACILITY_SUBTYPES = [
  'hospital',
  'snf',
  'alf',
  'independent_living',
  'memory_care',
  'rehab',
  'hospice',
  'home_health',
  'other',
];

export const FACILITY_SUBTYPE_LABELS = {
  hospital:           'Hospital',
  snf:                'SNF (Skilled nursing)',
  alf:                'ALF (Assisted living)',
  independent_living: 'Independent living',
  memory_care:        'Memory care',
  rehab:              'Rehab',
  hospice:            'Hospice',
  home_health:        'Home health',
  other:              'Other',
};

// bd_accounts.professional_subtype CHECK constraint domain.
export const PROFESSIONAL_SUBTYPES = [
  'gcm',
  'attorney',
  'financial_planner',
  'physician',
  'social_worker',
  'other',
];

export const PROFESSIONAL_SUBTYPE_LABELS = {
  gcm:               'Geriatric care manager',
  attorney:          'Attorney',
  financial_planner: 'Financial planner',
  physician:         'Physician',
  social_worker:     'Social worker',
  other:             'Other',
};

export function validateAccountDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'Missing form data.' };
  }
  if (!draft.name || !String(draft.name).trim()) {
    return { ok: false, error: 'Enter an account name.' };
  }
  if (!ACCOUNT_TYPES.includes(draft.account_type)) {
    return { ok: false, error: 'Pick an account type.' };
  }
  if (draft.account_type === 'facility') {
    if (!draft.facility_subtype) {
      return { ok: false, error: 'Pick a facility subtype.' };
    }
    if (!FACILITY_SUBTYPES.includes(draft.facility_subtype)) {
      return { ok: false, error: 'Invalid facility subtype.' };
    }
    if (draft.professional_subtype) {
      return { ok: false, error: 'A facility cannot have a professional subtype.' };
    }
  }
  if (draft.account_type === 'professional') {
    if (!draft.professional_subtype) {
      return { ok: false, error: 'Pick a professional subtype.' };
    }
    if (!PROFESSIONAL_SUBTYPES.includes(draft.professional_subtype)) {
      return { ok: false, error: 'Invalid professional subtype.' };
    }
    if (draft.facility_subtype) {
      return { ok: false, error: 'A professional cannot have a facility subtype.' };
    }
  }
  if (draft.website) {
    const w = String(draft.website).trim();
    if (w && !/^https?:\/\/|^[\w-]+\.[\w.-]+/i.test(w)) {
      return { ok: false, error: 'Website looks invalid.' };
    }
  }
  return { ok: true };
}

// Shapes the row written to bd_accounts. Trims strings, nulls empties,
// and never writes user-controllable booleans we don't expose.
export function buildAccountRow(draft, orgId, createdBy) {
  const subtype = draft.account_type === 'facility'
    ? (draft.facility_subtype || null)
    : null;
  const profSubtype = draft.account_type === 'professional'
    ? (draft.professional_subtype || null)
    : null;
  return {
    org_id:               orgId,
    name:                 String(draft.name).trim(),
    account_type:         draft.account_type,
    facility_subtype:     subtype,
    professional_subtype: profSubtype,
    address:              draft.address?.trim() || null,
    city:                 draft.city?.trim()    || null,
    state:                draft.state?.trim()   || null,
    zip:                  draft.zip?.trim()     || null,
    phone:                draft.phone?.trim()   || null,
    website:              draft.website?.trim() || null,
    notes:                draft.notes?.trim()   || null,
    is_strategic_shared:  Boolean(draft.is_strategic_shared),
    is_active:            true,
    source:               'manual',
    created_by:           createdBy ?? null,
  };
}

// Looks up case-insensitive name matches inside the same org. Returns
// up to `limit` rows shaped for the duplicate warning UI. RLS scopes
// the result to the caller's org regardless of whether org_id is
// passed; the explicit filter is belt-and-braces in case RLS is ever
// relaxed.
export async function findAccountDuplicates(supabase, { orgId, name, limit = 5 }) {
  if (!supabase) return { data: [], error: new Error('Supabase not configured.') };
  const clean = (name ?? '').trim();
  if (!clean) return { data: [], error: null };
  let q = supabase
    .from('bd_accounts')
    .select('id, name, city, account_type, facility_subtype, professional_subtype')
    .ilike('name', clean);
  if (orgId) q = q.eq('org_id', orgId);
  const res = await q.limit(limit);
  if (res.error) return { data: [], error: res.error };
  return { data: res.data ?? [], error: null };
}

// Creates a single bd_accounts row. When `force` is falsy, refuses to
// insert if a case-insensitive same-name match exists in the org and
// returns the existing rows so the caller can show a duplicate
// warning. Pass `force: true` to bypass after the user confirms.
// Returns { data, error, duplicate, duplicates }.
export async function createAccount(supabase, { orgId, draft, createdBy, force = false }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  const validation = validateAccountDraft(draft);
  if (!validation.ok) return { data: null, error: new Error(validation.error) };
  if (!orgId) return { data: null, error: new Error('Missing org_id from session — sign out and back in.') };

  if (!force) {
    const dupRes = await findAccountDuplicates(supabase, { orgId, name: draft.name });
    if (dupRes.error) return { data: null, error: dupRes.error };
    if ((dupRes.data ?? []).length > 0) {
      return {
        data: null,
        error: null,
        duplicate: true,
        duplicates: dupRes.data,
      };
    }
  }

  const row = buildAccountRow(draft, orgId, createdBy);
  const insertRes = await supabase
    .from('bd_accounts')
    .insert(row)
    .select('id, name, account_type, facility_subtype, professional_subtype, city, state')
    .single();
  if (insertRes.error) return { data: null, error: insertRes.error };

  return { data: insertRes.data, error: null, duplicate: false };
}

// Creates an account and, in the same call, inserts 0..N contact rows
// linked to the new account. Best-effort on contacts: if one contact
// insert fails, the others (and the account) are kept; failures are
// returned in `contactErrors` so the UI can show a partial-success
// message. Only the first contact marked is_primary keeps the flag;
// the rest are demoted to false to avoid multiple primaries on the
// same account.
export async function createAccountWithContacts(supabase, {
  orgId, draft, contactDrafts = [], createdBy, force = false,
}) {
  const accountRes = await createAccount(supabase, { orgId, draft, createdBy, force });
  if (accountRes.error) return { ...accountRes, contacts: [], contactErrors: [] };
  if (accountRes.duplicate) return { ...accountRes, contacts: [], contactErrors: [] };

  const account = accountRes.data;
  const cleaned = (contactDrafts ?? [])
    .filter((c) => c && c.name && String(c.name).trim());

  // Only the first primary stays primary.
  let primaryClaimed = false;
  const contacts = [];
  const contactErrors = [];
  for (const c of cleaned) {
    const keepPrimary = Boolean(c.is_primary) && !primaryClaimed;
    if (keepPrimary) primaryClaimed = true;
    const cDraft = {
      account_id:   account.id,
      name:         c.name,
      title:        c.title,
      role:         c.role || null,
      email:        c.email,
      phone_mobile: c.phone_mobile,
      phone_office: c.phone_office,
      notes:        c.notes,
      is_primary:   keepPrimary,
    };
    const cRes = await createContact(supabase, { orgId, draft: cDraft, createdBy });
    if (cRes.error) {
      contactErrors.push({ name: c.name, error: cRes.error });
      continue;
    }
    if (cRes.data?.created) contacts.push(cRes.data.created);
    else if (cRes.data?.existing) contacts.push(cRes.data.existing);
  }

  return { data: account, error: null, duplicate: false, contacts, contactErrors };
}

// ─── Account update ─────────────────────────────────────────────
//
// Edits an existing bd_accounts row from the account profile's "Edit"
// screen. Shares validateAccountDraft with the create flow so the rep
// gets the same guardrails (name required, type/subtype must be a
// matched pair in the CHECK domain, website sanity check) whether she's
// adding or editing.
//
// Note on lat/lng: we intentionally leave the geocode pin untouched
// here, matching the inline address editor (updateAccountLocation),
// which also never clears lat/lng on an address change.

// Builds the partial UPDATE payload for an account edit. Mirrors
// buildAccountRow's field shaping (trim + null-on-empty, wrong-axis
// subtype cleared) but omits insert-only columns (org_id, source,
// is_active, created_by) and stamps updated_at.
export function buildAccountUpdatePatch(draft) {
  const subtype = draft.account_type === 'facility'
    ? (draft.facility_subtype || null)
    : null;
  const profSubtype = draft.account_type === 'professional'
    ? (draft.professional_subtype || null)
    : null;
  return {
    name:                 String(draft.name).trim(),
    account_type:         draft.account_type,
    facility_subtype:     subtype,
    professional_subtype: profSubtype,
    address:              draft.address?.trim() || null,
    city:                 draft.city?.trim()    || null,
    state:                draft.state?.trim()   || null,
    zip:                  draft.zip?.trim()     || null,
    phone:                draft.phone?.trim()   || null,
    website:              draft.website?.trim() || null,
    notes:                draft.notes?.trim()   || null,
    is_strategic_shared:  Boolean(draft.is_strategic_shared),
    updated_at:           new Date().toISOString(),
  };
}

export async function updateAccount(supabase, { accountId, draft }) {
  if (!supabase) return { data: null, error: new Error('Supabase not configured.') };
  if (!accountId) return { data: null, error: new Error('Missing account id.') };
  const validation = validateAccountDraft(draft);
  if (!validation.ok) return { data: null, error: new Error(validation.error) };

  const patch = buildAccountUpdatePatch(draft);
  const res = await supabase
    .from('bd_accounts')
    .update(patch)
    .eq('id', accountId)
    .select('id, name, account_type, facility_subtype, professional_subtype, address, city, state, zip, phone, website, notes, is_strategic_shared')
    .single();
  if (res.error) return { data: null, error: res.error };
  return { data: res.data, error: null };
}

// ─── Account stars (personal favorites) ─────────────────────────────
//
// Toggle a star on/off for the current user. RLS enforces user
// scoping (we never set user_id explicitly client-side; the policy's
// WITH CHECK requires it to equal auth.uid()). We resolve the
// authenticated user id via getSession() so the INSERT body satisfies
// the NOT NULL on user_id.
//
// `starred` is the desired final state (true → INSERT, false → DELETE).
// The caller decides intent rather than us toggling based on a current-
// state read, so optimistic UI updates can call this directly with the
// post-tap value.

export async function setAccountStarred(supabase, { accountId, starred }) {
  if (!supabase) return { ok: false, error: new Error('Supabase not configured.') };
  if (!accountId) return { ok: false, error: new Error('Missing account id.') };

  const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
  if (sessionErr) return { ok: false, error: sessionErr };
  const userId = sessionData?.session?.user?.id;
  if (!userId) return { ok: false, error: new Error('Not signed in.') };

  if (starred) {
    // Idempotent INSERT — if the (account_id, user_id) PK conflict
    // hits we treat it as a no-op (already starred).
    const res = await supabase
      .from('bd_account_stars')
      .upsert(
        { account_id: accountId, user_id: userId },
        { onConflict: 'account_id,user_id', ignoreDuplicates: true },
      );
    if (res.error) return { ok: false, error: res.error };
    return { ok: true, error: null };
  }

  const res = await supabase
    .from('bd_account_stars')
    .delete()
    .eq('account_id', accountId)
    .eq('user_id', userId);
  if (res.error) return { ok: false, error: res.error };
  return { ok: true, error: null };
}

