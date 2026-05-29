import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { fetchStarredAccountIdsForUser } from '../lib/bdQueries';
import { setAccountStarred } from '../lib/bdMutations';
import { useBdViewAs } from '../context/BdViewAsContext';

// Loads the current user's starred account ids and exposes a toggle.
//
// Returns `{ starredIds, isStarred, toggle, refresh, error }`:
//   - starredIds: a Set<uuid> of account ids the rep has starred.
//     Empty Set on first load or on fetch failure.
//   - isStarred(id): O(1) lookup helper.
//   - toggle(id): flips the star and refreshes the set. Optimistically
//     updates the local Set on tap so the UI feels instant; reverts
//     if the underlying mutation fails.
//   - refresh(): re-queries the server (used after sign-in changes).
//
// Implementation notes:
//   - One round-trip per session — the rep's starred list is small
//     (<100 typically) so we hold the full Set in memory and never
//     paginate.
//   - Errors during toggle are surfaced through `error` so the calling
//     component can show a transient failure banner. The optimistic
//     update is reverted before `error` flips.
export function useBdAccountStars() {
  const { effectiveUserId, isReadOnly } = useBdViewAs();
  const [starredIds, setStarredIds] = useState(() => new Set());
  const [error, setError] = useState(null);

  // Stars are scoped to the effective user (self, or the rep an owner is
  // auditing). The explicit user_id filter is required: with the owner
  // read-override policy in place an unfiltered query would merge every
  // rep's stars. Until the effective user resolves we hold an empty set.
  const refresh = useCallback(async () => {
    setError(null);
    const res = await fetchStarredAccountIdsForUser(supabase, effectiveUserId);
    if (res.error) {
      setError(res.error);
      return;
    }
    setStarredIds(res.data ?? new Set());
  }, [effectiveUserId]);

  useEffect(() => { refresh(); }, [refresh]);

  const toggle = useCallback(async (accountId) => {
    if (!accountId) return;
    // Read-only while auditing another rep — starring is a personal,
    // per-user write that would land under the owner's own id, never the
    // audited rep's, so we simply no-op.
    if (isReadOnly) return;
    // Optimistic local update so the star icon flips immediately on
    // tap. We snapshot the prior set in case we need to roll back.
    const prior = starredIds;
    const next = new Set(prior);
    const willStar = !next.has(accountId);
    if (willStar) next.add(accountId);
    else next.delete(accountId);
    setStarredIds(next);

    const res = await setAccountStarred(supabase, { accountId, starred: willStar });
    if (!res.ok) {
      setStarredIds(prior);
      setError(res.error);
    }
  }, [starredIds, isReadOnly]);

  const isStarred = useCallback((id) => starredIds.has(id), [starredIds]);

  return { starredIds, isStarred, toggle, refresh, error };
}
