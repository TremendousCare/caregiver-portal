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
