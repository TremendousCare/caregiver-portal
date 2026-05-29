// BD "view-as" pure helpers.
//
// The owner of the business (role = 'owner') manages the BD reps and
// needs to audit a rep by seeing the *exact* portal that rep sees —
// their territory accounts, their starred shortlist, their mileage.
// Everyone else (admin, member) only ever sees their own instance.
//
// These are pure functions so the selection/derivation logic is unit-
// testable without React or Supabase. The React glue lives in
// context/BdViewAsContext.jsx; the data fetchers live in bdQueries.js.

// Thrown by the mutation hooks when a write is attempted while an owner
// is viewing another rep's portal. The mirror is strictly read-only:
// the database also refuses the write (the INSERT/UPDATE/DELETE policies
// stay user_id = auth.uid()), but failing fast in the client gives a
// clean message instead of a raw RLS rejection.
export const VIEW_AS_READONLY_MESSAGE =
  "You're viewing another rep's portal (read-only). Exit the audit view to make changes.";

export class ViewAsReadOnlyError extends Error {
  constructor(message = VIEW_AS_READONLY_MESSAGE) {
    super(message);
    this.name = 'ViewAsReadOnlyError';
    this.readOnly = true;
  }
}

// sessionStorage key holding the currently-audited rep's user id. Scoped
// to the tab so an owner can audit a rep in one tab and work normally in
// another, and so the selection survives in-portal navigation without
// leaking across a full sign-out (sessionStorage clears with the tab).
export const VIEW_AS_STORAGE_KEY = 'bd:viewAsUserId';

// A view-as selection is only honored when the target is a real rep in
// the owner's auditable list. A stale id (rep removed from a territory,
// or a tampered sessionStorage value) is ignored rather than trusted —
// the RPCs would fail closed anyway, but we never want the UI to claim
// it's mirroring a rep it can't actually resolve.
export function sanitizeViewAsUserId(viewAsUserId, reps) {
  if (!viewAsUserId) return null;
  const list = Array.isArray(reps) ? reps : [];
  return list.some((r) => r && r.user_id === viewAsUserId) ? viewAsUserId : null;
}

// The user id every per-rep query should scope to: the audited rep when
// a valid view-as selection is active, otherwise the signed-in user.
// Returns null only before the session has resolved (selfUserId unknown),
// which the consuming hooks treat as "don't fetch yet."
export function deriveEffectiveUserId({ selfUserId = null, viewAsUserId = null, reps = [] } = {}) {
  const valid = sanitizeViewAsUserId(viewAsUserId, reps);
  return valid ?? selfUserId ?? null;
}

// True when the owner is actively mirroring a *different* rep. Selecting
// yourself (or an unresolved/stale id) is not "viewing as" — it's just
// your own view.
export function isViewingAs({ selfUserId = null, viewAsUserId = null, reps = [] } = {}) {
  const valid = sanitizeViewAsUserId(viewAsUserId, reps);
  return Boolean(valid && valid !== selfUserId);
}

// The rep record currently being audited, or null when not viewing-as.
export function findRep(reps, userId) {
  if (!userId) return null;
  const list = Array.isArray(reps) ? reps : [];
  return list.find((r) => r && r.user_id === userId) ?? null;
}

// Display label for a rep row. Prefers the full name, falls back to the
// email local-part, then a generic label so the banner/picker never
// renders an empty string.
export function repDisplayName(rep) {
  if (!rep) return 'rep';
  if (rep.full_name && rep.full_name.trim()) return rep.full_name.trim();
  if (rep.email && rep.email.includes('@')) return rep.email.split('@')[0];
  if (rep.email) return rep.email;
  return 'rep';
}
