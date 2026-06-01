import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';

// Calls the bd-briefing edge function with the user's current supabase
// JWT plus the *effective* rep identity, so the narrative + stats are
// scoped to that rep (their own session normally, or the rep an owner is
// auditing while viewing-as). Returns null when not signed in or supabase
// isn't configured. Failure modes degrade silently — the Today screen
// shows a static fallback if the briefing isn't available.
//
// `identity` is the object returned by resolveBriefingIdentity:
//   { name, userId, createdByCandidates }
// We forward it in the POST body. We also send the client's local hour +
// date label so the greeting and the prompt's "today is…" context are
// correct in the rep's timezone rather than the edge runtime's UTC.
export function useBdBriefing(identity) {
  const { name = '', userId = null, createdByCandidates = [] } = identity ?? {};
  const [loading, setLoading] = useState(true);
  const [briefing, setBriefing] = useState(null);
  const [error, setError] = useState(null);

  // Serialize the candidate array for a stable useCallback dependency so
  // an identical identity object on re-render doesn't refetch.
  const candidatesKey = createdByCandidates.join('|');

  const load = useCallback(async () => {
    if (!supabase || !SUPABASE_URL) {
      setLoading(false);
      return;
    }
    // Wait for the effective identity to resolve before firing. Fetching
    // with a null userId would make the edge function fall back to an
    // org-wide briefing, then we'd refetch scoped the moment identity
    // lands — a wasted Claude call and a flash of the wrong numbers.
    if (!userId) {
      setLoading(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setBriefing(null);
        setLoading(false);
        return;
      }
      const now = new Date();
      const body = {
        name,
        userId,
        createdBy: candidatesKey ? candidatesKey.split('|') : [],
        localHour: now.getHours(),
        localDateLabel: now.toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric',
        }),
      };
      const url = new URL(`${SUPABASE_URL}/functions/v1/bd-briefing`);
      const resp = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`Briefing failed (${resp.status}): ${t.slice(0, 120)}`);
      }
      const j = await resp.json();
      setBriefing(j);
    } catch (e) {
      setError(e);
      setBriefing(null);
    } finally {
      setLoading(false);
    }
  }, [name, userId, candidatesKey]);

  useEffect(() => { load(); }, [load]);

  return { loading, briefing, error, refresh: load };
}
