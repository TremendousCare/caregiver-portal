// BD mileage tracker — pure helpers.
//
// Splits the validation, math, and formatting out of the React
// components so each piece is unit-testable in isolation. The hook
// (useBdLogMileage) and the form (MileageEntryForm) both call into
// these helpers.

// IRS standard mileage rate, in cents per mile. Used as the fallback
// when organizations.settings.mileage.default_rate_cents_per_mile is
// not set. Bumped annually when the IRS publishes the new rate.
export const DEFAULT_MILEAGE_RATE_CENTS = 70;

export const MILEAGE_SOURCES = ['odometer', 'manual', 'gps_estimate'];
export const MILEAGE_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'paid'];
export const MILEAGE_STATUS_LABELS = {
  draft:     'Draft',
  submitted: 'Submitted',
  approved:  'Approved',
  rejected:  'Rejected',
  paid:      'Paid',
};

// `miles < 10000` matches the table-level CHECK; anything beyond
// that is almost certainly a typo (a rep won't drive 10,000 miles
// in one trip).
export const MAX_MILES_PER_ENTRY = 9999.99;

// Cents per mile clamp. The IRS standard rate has historically sat
// in the 50–70¢ range; a four-digit value (1000 = $10/mi) is loud
// enough to catch a "I entered cents not dollars" typo.
export const MAX_RATE_CENTS_PER_MILE = 1000;

// Compute miles from an odometer pair. Returns null if either side
// is missing / invalid, or if end < start. Caller decides whether
// to surface that as a validation error.
export function computeMilesFromOdometer(start, end) {
  // Reject nullish explicitly — `Number(null)` is 0, which would
  // otherwise quietly produce a bogus "your end odometer is 10
  // miles" reading from a half-filled form.
  if (start === null || start === undefined || start === '') return null;
  if (end   === null || end   === undefined || end   === '') return null;
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (s < 0 || e < 0) return null;
  if (e < s) return null;
  return e - s;
}

// Round miles to two decimal places (matches numeric(7,2) storage).
// Returns null for non-finite input.
export function roundMiles(miles) {
  const n = Number(miles);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

// Compute reimbursement in whole cents from miles + rate. Both must
// be finite non-negative numbers; returns 0 otherwise so a partial
// form does not surface NaN.
export function computeReimbursementCents(miles, rateCentsPerMile) {
  const m = Number(miles);
  const r = Number(rateCentsPerMile);
  if (!Number.isFinite(m) || m < 0) return 0;
  if (!Number.isFinite(r) || r < 0) return 0;
  return Math.round(m * r);
}

// Format a cents value as a USD string. Lightweight, no Intl call —
// runs in the form on every keystroke.
export function formatCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '$0.00';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars.toLocaleString('en-US')}.${remainder.toString().padStart(2, '0')}`;
}

// Format a miles value with one decimal place, dropping a trailing
// zero. "12.0" → "12", "12.3" → "12.3", "12.34" → "12.3".
export function formatMiles(miles) {
  const n = Number(miles);
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// Validates a mileage entry draft before insert/update. Returns
// { ok: true } on success or { ok: false, error } on the first
// failure. Mirrors the table-level CHECK constraints so a draft that
// passes here also passes the DB.
export function validateMileageDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'Missing form data.' };
  }
  if (!draft.trip_date) {
    return { ok: false, error: 'Set a trip date.' };
  }
  if (Number.isNaN(new Date(draft.trip_date).getTime())) {
    return { ok: false, error: 'That trip date is not valid.' };
  }
  if (typeof draft.purpose !== 'string' || draft.purpose.trim().length === 0) {
    return { ok: false, error: 'Add a business purpose.' };
  }
  const miles = Number(draft.miles);
  if (!Number.isFinite(miles) || miles <= 0) {
    return { ok: false, error: 'Enter miles greater than zero.' };
  }
  if (miles > MAX_MILES_PER_ENTRY) {
    return { ok: false, error: `Miles must be under ${MAX_MILES_PER_ENTRY}.` };
  }
  if (!MILEAGE_SOURCES.includes(draft.source)) {
    return { ok: false, error: 'Pick a mileage source.' };
  }
  if (draft.source === 'odometer') {
    const odoMiles = computeMilesFromOdometer(draft.odometer_start, draft.odometer_end);
    if (odoMiles === null) {
      return { ok: false, error: 'Odometer end must be at or after odometer start.' };
    }
  }
  const rate = Number(draft.rate_cents_per_mile);
  if (!Number.isFinite(rate) || rate < 0) {
    return { ok: false, error: 'Reimbursement rate must be zero or positive.' };
  }
  if (rate > MAX_RATE_CENTS_PER_MILE) {
    return { ok: false, error: `Rate must be ${MAX_RATE_CENTS_PER_MILE}¢ or less.` };
  }
  if (draft.status && !MILEAGE_STATUSES.includes(draft.status)) {
    return { ok: false, error: 'Unknown status.' };
  }
  return { ok: true };
}

// Builds the row passed to bd_mileage_entries.insert. Decoupled so
// the column shape lives in one place.
export function buildMileageRow(draft, { orgId, userId, createdBy }) {
  const miles = roundMiles(draft.miles);
  const rate = Number(draft.rate_cents_per_mile);
  return {
    org_id:                orgId,
    user_id:               userId,
    trip_date:             draft.trip_date,
    started_at:            draft.started_at ?? null,
    ended_at:              draft.ended_at ?? null,
    odometer_start:        numOrNull(draft.odometer_start),
    odometer_end:          numOrNull(draft.odometer_end),
    miles,
    source:                draft.source,
    start_location:        emptyToNull(draft.start_location),
    end_location:          emptyToNull(draft.end_location),
    start_lat:             numOrNull(draft.start_lat),
    start_lng:             numOrNull(draft.start_lng),
    end_lat:               numOrNull(draft.end_lat),
    end_lng:               numOrNull(draft.end_lng),
    purpose:               draft.purpose.trim(),
    is_round_trip:         !!draft.is_round_trip,
    account_id:            draft.account_id ?? null,
    activity_id:           draft.activity_id ?? null,
    rate_cents_per_mile:   rate,
    reimbursement_cents:   computeReimbursementCents(miles, rate),
    status:                draft.status ?? 'draft',
    submitted_at:          draft.status === 'submitted' ? new Date().toISOString() : null,
    notes:                 emptyToNull(draft.notes),
    created_by:            createdBy ?? null,
  };
}

// True when the current user can still edit the entry. v1 rule:
// only `draft` is editable. Anything submitted / approved / paid
// is locked from the rep's view (admins may unlock via service-role
// tooling). Centralised so the list view, the form, and any future
// mobile widget share the same gate.
export function isMileageEntryEditable(entry, currentUserId) {
  if (!entry || !currentUserId) return false;
  if (entry.user_id !== currentUserId) return false;
  return entry.status === 'draft';
}

// Group a list of entries by yyyy-mm (UTC). Used by MileageList to
// render month headers + per-month totals.
export function groupEntriesByMonth(entries) {
  const out = {};
  for (const entry of entries ?? []) {
    if (!entry?.trip_date) continue;
    // trip_date is a `date` column → "YYYY-MM-DD". Take the
    // first 7 chars instead of new Date() to dodge UTC-vs-local
    // off-by-one at the month boundary. Validate the shape so a
    // junk string ("garbage") doesn't slot in as its own month.
    const key = String(entry.trip_date).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    if (!out[key]) out[key] = [];
    out[key].push(entry);
  }
  return out;
}

// Sum miles + reimbursement for a list of entries. Used by the
// month-header rollups and the per-entry totals.
export function totalsForEntries(entries) {
  let miles = 0;
  let cents = 0;
  for (const entry of entries ?? []) {
    const m = Number(entry?.miles);
    const c = Number(entry?.reimbursement_cents);
    if (Number.isFinite(m)) miles += m;
    if (Number.isFinite(c)) cents += c;
  }
  return {
    miles: roundMiles(miles) ?? 0,
    reimbursement_cents: cents,
  };
}

// Helpers ------------------------------------------------------------

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function emptyToNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
