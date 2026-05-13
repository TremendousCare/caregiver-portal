// ─────────────────────────────────────────────────────────────────
// Voice / CTI Phase 1 PR 3 — VoiceProvider
//
// Owns:
//   - The Supabase Realtime subscription on `call_sessions` filtered
//     to rows where matched_user_id = the logged-in portal user.
//     RLS already restricts this to the user's own org; the filter
//     narrows further to "calls that ring my extension."
//   - The current/recently-ended call state via callPopReducer.
//   - Async name lookups for matched_entity_id → caregivers/clients
//     so the toast can show "Sarah Chen" instead of just "+1..."
//   - Triggering the click-to-call REST action via the telephony
//     webhook function. The webhook handles RC auth + RingOut.
//
// Mounted from AdminApp inside the AuthGate so currentUser is ready.
// ─────────────────────────────────────────────────────────────────

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useCallback,
} from 'react';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import {
  initialVoiceState,
  rowToVoiceCall,
  applyRowEvent,
  dismissActiveCall,
  clearRecentlyEnded,
} from '../../lib/voice/callPopReducer';

const VoiceContext = createContext(null);

// How long the "Call ended" flash sticks around before disappearing.
const RECENTLY_ENDED_MS = 6000;

function reducer(state, action) {
  switch (action.type) {
    case 'ROW_EVENT':
      return applyRowEvent(state, action.payload);
    case 'DISMISS':
      return dismissActiveCall(state);
    case 'CLEAR_RECENTLY_ENDED':
      return clearRecentlyEnded(state);
    default:
      return state;
  }
}

export function VoiceProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialVoiceState);
  // Cache of entity_id → name so we don't re-query the same name
  // across many UPDATEs for the same call.
  const nameCacheRef = useRef(new Map());
  // Hold the current auth user id so we can filter the subscription.
  const userIdRef = useRef(null);

  // ─── Resolve entity name for a matched call row ───
  const enrichWithName = useCallback(async (call) => {
    if (!call.matchedEntityType || !call.matchedEntityId) return call;
    const cacheKey = `${call.matchedEntityType}:${call.matchedEntityId}`;
    const cached = nameCacheRef.current.get(cacheKey);
    if (cached) {
      return { ...call, matchedEntityName: cached };
    }
    if (!isSupabaseConfigured()) return call;
    const tableName = call.matchedEntityType === 'client' ? 'clients' : 'caregivers';
    try {
      const { data } = await supabase
        .from(tableName)
        .select('first_name, last_name')
        .eq('id', call.matchedEntityId)
        .maybeSingle();
      if (data) {
        const name = `${data.first_name ?? ''} ${data.last_name ?? ''}`.trim() || null;
        if (name) nameCacheRef.current.set(cacheKey, name);
        return { ...call, matchedEntityName: name };
      }
    } catch (err) {
      console.warn('[VoiceProvider] name lookup failed:', err.message);
    }
    return call;
  }, []);

  // ─── Realtime subscription on call_sessions filtered to bound extensions ──
  // PR 3.4 changed this from matched_user_id=eq.<self> to
  // extension_id=in.(<my_exts>) so that on-call rotations work:
  // every user bound to a shared extension sees the screen-pop
  // concurrently, regardless of which user the webhook happened to
  // stamp as matched_user_id first. RLS on call_sessions still keeps
  // it tenant-safe (org_id filter from PR 1's tenant_isolation
  // policies); the extension filter is the additional narrowing.
  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let cancelled = false;
    let channel = null;

    (async () => {
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id;
      if (!userId || cancelled) return;
      userIdRef.current = userId;

      // Look up the bound extension(s) for this user. Only org_memberships
      // rows for the current user are visible under the existing
      // users_read_own_memberships SELECT policy — no extra RPC needed.
      const { data: myMemberships } = await supabase
        .from('org_memberships')
        .select('ringcentral_extension_id')
        .not('ringcentral_extension_id', 'is', null);
      const myExtensions = (myMemberships || [])
        .map((r) => r.ringcentral_extension_id)
        .filter(Boolean);

      if (myExtensions.length === 0 || cancelled) {
        // No bound extensions → nothing to subscribe to. The user will
        // see no screen-pops; admin needs to bind their RC extension
        // in Settings → Voice & Calls.
        return;
      }

      // postgres_changes `in.(a,b,c)` filter syntax — comma-separated,
      // no quotes, no spaces.
      const filterValue = `extension_id=in.(${myExtensions.join(',')})`;

      channel = supabase
        .channel(`call_sessions:exts:${userId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'call_sessions',
            filter: filterValue,
          },
          async (payload) => {
            const row = payload.new || payload.old;
            if (!row || !row.id) return;
            // INSERT and UPDATE both feed the reducer; DELETE is rare
            // for call_sessions and we treat it as a no-op.
            if (payload.eventType === 'DELETE') return;
            const baseCall = rowToVoiceCall(row);
            const enriched = await enrichWithName(baseCall);
            if (cancelled) return;
            dispatch({ type: 'ROW_EVENT', payload: enriched });
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [enrichWithName]);

  // ─── Auto-clear recently-ended toast after a delay ───
  useEffect(() => {
    if (!state.recentlyEnded) return undefined;
    const t = setTimeout(() => dispatch({ type: 'CLEAR_RECENTLY_ENDED' }), RECENTLY_ENDED_MS);
    return () => clearTimeout(t);
  }, [state.recentlyEnded]);

  // ─── Click-to-call ───
  // Deferred to PR 3.1. RingOut requires the user's personal callback
  // phone (the line RC rings first before bridging to the destination),
  // which we don't yet collect or store. Stubbed here so consumers can
  // import a stable API surface; returns success:false until the
  // backend ?action=ringout endpoint lands.
  const placeCall = useCallback(async () => {
    return { success: false, error: 'Click-to-call not yet enabled (PR 3.1)' };
  }, []);

  const value = useMemo(
    () => ({
      activeCall: state.activeCall,
      recentlyEnded: state.recentlyEnded,
      dismissActive: () => dispatch({ type: 'DISMISS' }),
      placeCall,
    }),
    [state.activeCall, state.recentlyEnded, placeCall],
  );

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice() {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoice must be used within VoiceProvider');
  return ctx;
}
