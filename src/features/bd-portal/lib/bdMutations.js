// BD write-side helpers. Pure validators + a thin Supabase wrapper for
// inserting an activity and refreshing the parent account's
// last_activity_at. Kept separate from React so the validation logic
// can be unit-tested against a stub client.

export const QUICK_CAPTURE_TYPES = ['visit', 'call', 'email', 'drop_off', 'note'];
export const QUICK_CAPTURE_LABELS = {
  visit:    'Visit',
  call:     'Call',
  email:    'Email',
  drop_off: 'Drop-off',
  note:     'Note',
};
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
  if (!QUICK_CAPTURE_TYPES.includes(draft.activity_type)) {
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
