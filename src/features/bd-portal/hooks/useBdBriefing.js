import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';

// Calls the bd-briefing edge function with the user's current
// supabase JWT. Returns null when not signed in or supabase isn't
// configured. Failure modes degrade silently — the Today screen
// shows a static fallback if the briefing isn't available.
export function useBdBriefing(displayName) {
  const [loading, setLoading] = useState(true);
  const [briefing, setBriefing] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!supabase || !SUPABASE_URL) {
      setLoading(false);
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
      const url = new URL(`${SUPABASE_URL}/functions/v1/bd-briefing`);
      if (displayName) url.searchParams.set('name', displayName);
      const resp = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
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
  }, [displayName]);

  useEffect(() => { load(); }, [load]);

  return { loading, briefing, error, refresh: load };
}
