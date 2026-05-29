import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { fetchAuditableReps } from '../lib/bdQueries';
import {
  VIEW_AS_STORAGE_KEY,
  deriveEffectiveUserId,
  isViewingAs as computeIsViewingAs,
  findRep,
  sanitizeViewAsUserId,
} from '../lib/bdViewAs';

// React glue for the owner "view-as" (read-only rep audit) feature.
//
// The provider wraps the whole BD portal (mounted in BDApp). It resolves
// the signed-in user id and — for owners only — the list of reps they may
// audit, then exposes the "effective" user id that every per-rep query
// should scope to. Non-owners get reps = [] (the RPC gates on is_owner)
// so canViewAs is false and effectiveUserId is always just their own id.
//
// Consuming hooks (useBdAccounts, useBdAccountStars, useBdMileageEntries)
// read effectiveUserId and refetch when it changes; the mutation hooks
// read isReadOnly to refuse writes while auditing.

const DEFAULT_VALUE = {
  ready: false,
  selfUserId: null,
  effectiveUserId: null,
  reps: [],
  canViewAs: false,
  isViewingAs: false,
  isReadOnly: false,
  viewAsUserId: null,
  effectiveRep: null,
  setViewAsRep: () => {},
  clearViewAs: () => {},
};

const BdViewAsContext = createContext(DEFAULT_VALUE);

export function useBdViewAs() {
  return useContext(BdViewAsContext);
}

function readStoredViewAs() {
  try {
    return sessionStorage.getItem(VIEW_AS_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function BdViewAsProvider({ children }) {
  const [selfUserId, setSelfUserId] = useState(null);
  const [reps, setReps] = useState([]);
  const [viewAsUserId, setViewAsUserIdState] = useState(readStoredViewAs);
  const [ready, setReady] = useState(false);

  // Resolve identity, then (separately) the auditable reps.
  //
  // Ordering matters for performance: the data hooks (accounts, stars,
  // mileage) gate their fetches on `effectiveUserId`, which derives from
  // `selfUserId`. We therefore set `selfUserId` from the *local* session
  // first so those fetches fire immediately, and load the auditable-rep
  // list — which is only needed for the owner picker — in a second,
  // non-blocking step. Putting the reps RPC in front of selfUserId added
  // a full network round-trip to every BD page load (members get an
  // empty list from the is_owner()-gated RPC, so it's pure latency).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let uid = null;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        uid = session?.user?.id ?? null;
      } catch { /* leave uid null — hooks fall back to their own session */ }
      if (cancelled) return;
      setSelfUserId(uid);

      // Auditable reps load off the critical path. Failures are
      // non-fatal — the picker just stays hidden.
      try {
        const { data: repList } = await fetchAuditableReps(supabase);
        if (!cancelled) setReps(repList ?? []);
      } catch {
        if (!cancelled) setReps([]);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setViewAsRep = useCallback((userId) => {
    setViewAsUserIdState(userId || null);
    try {
      if (userId) sessionStorage.setItem(VIEW_AS_STORAGE_KEY, userId);
      else sessionStorage.removeItem(VIEW_AS_STORAGE_KEY);
    } catch {
      /* sessionStorage unavailable (private mode) — selection still
         works for the current render tree, just not across reloads. */
    }
  }, []);

  const clearViewAs = useCallback(() => setViewAsRep(null), [setViewAsRep]);

  const value = useMemo(() => {
    const validViewAs = sanitizeViewAsUserId(viewAsUserId, reps);
    const effectiveUserId = deriveEffectiveUserId({ selfUserId, viewAsUserId, reps });
    const viewingAs = computeIsViewingAs({ selfUserId, viewAsUserId, reps });
    return {
      ready,
      selfUserId,
      effectiveUserId,
      reps,
      canViewAs: reps.length > 0,
      isViewingAs: viewingAs,
      isReadOnly: viewingAs,
      viewAsUserId: validViewAs,
      effectiveRep: viewingAs ? findRep(reps, validViewAs) : null,
      setViewAsRep,
      clearViewAs,
    };
  }, [ready, selfUserId, reps, viewAsUserId, setViewAsRep, clearViewAs]);

  return (
    <BdViewAsContext.Provider value={value}>
      {children}
    </BdViewAsContext.Provider>
  );
}
