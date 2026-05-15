import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { fetchCurrentUserStarredAccountIds } from '../lib/bdQueries';
import { setAccountStarred } from '../lib/bdMutations';

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
  const [starredIds, setStarredIds] = useState(() => new Set());
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    const res = await fetchCurrentUserStarredAccountIds(supabase);
    if (res.error) {
      setError(res.error);
      return;
    }
    setStarredIds(res.data ?? new Set());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const toggle = useCallback(async (accountId) => {
    if (!accountId) return;
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
  }, [starredIds]);

  const isStarred = useCallback((id) => starredIds.has(id), [starredIds]);

  return { starredIds, isStarred, toggle, refresh, error };
}
