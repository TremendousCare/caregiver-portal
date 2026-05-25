// Pure helpers for auto-filling shift rates from caregiver/client
// defaults. Extracted from ShiftForm so the rules can be unit-tested
// independently of React state.
//
// Mirrors the DB trigger in migration 20260526000000:
//   - Only fills when the existing value is null/empty.
//   - Never overwrites an explicitly-typed value.
//   - Returns a NEW draft object so React state updates trigger
//     re-render (no in-place mutation).
//
// The DB trigger is the source of truth — these helpers are a UX
// nicety that pre-populates the form so the office sees the default
// before they submit. If the helper is bypassed (bulk import,
// automation, edge function), the trigger still does the right thing.

function isEmptyRate(v) {
  return v === null || v === undefined || v === '';
}

/**
 * Auto-fill the caregiver-pay rate (`hourlyRate`) on a shift draft
 * from the caregiver's `defaultPayRate`. No-op when the draft already
 * has a rate or the caregiver has no default.
 *
 * @param {object} draft  - The shift form draft (with hourlyRate, etc.)
 * @param {object} caregiver - The full caregiver object with defaultPayRate
 * @returns {object} - New draft, possibly with hourlyRate filled in.
 */
export function applyCaregiverDefaultRate(draft, caregiver) {
  if (!draft) return draft;
  if (!isEmptyRate(draft.hourlyRate)) return draft;
  if (!caregiver) return draft;
  const rate = caregiver.defaultPayRate;
  if (rate === null || rate === undefined) return draft;
  return { ...draft, hourlyRate: rate };
}

/**
 * Auto-fill the client-bill rate (`billableRate`) on a shift draft
 * from the client's `defaultBillableRate`. No-op when the draft
 * already has a rate or the client has no default.
 */
export function applyClientDefaultRate(draft, client) {
  if (!draft) return draft;
  if (!isEmptyRate(draft.billableRate)) return draft;
  if (!client) return draft;
  const rate = client.defaultBillableRate;
  if (rate === null || rate === undefined) return draft;
  return { ...draft, billableRate: rate };
}

/**
 * Returns true when the given draft rate exactly matches the
 * caregiver/client default. Used by the UI to show a "(from default)"
 * hint so the office knows where the auto-filled value came from.
 */
export function matchesCaregiverDefault(draftRate, caregiver) {
  if (!caregiver) return false;
  const def = caregiver.defaultPayRate;
  if (def === null || def === undefined) return false;
  if (draftRate === null || draftRate === undefined || draftRate === '') return false;
  return Number(draftRate) === Number(def);
}

export function matchesClientDefault(draftRate, client) {
  if (!client) return false;
  const def = client.defaultBillableRate;
  if (def === null || def === undefined) return false;
  if (draftRate === null || draftRate === undefined || draftRate === '') return false;
  return Number(draftRate) === Number(def);
}
