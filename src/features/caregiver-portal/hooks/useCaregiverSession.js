import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';

// useCaregiverSession
// ───────────────────
// Drives the auth state for the /care PWA. Flow:
//   1. Get the current supabase auth session (or null).
//   2. If authed, SELECT the caregivers row where user_id = auth.uid().
//      RLS policy `caregivers_read_own` returns exactly that row (or
//      nothing) for a caregiver user.
//   3. If no caregiver row comes back, call the `caregiver-invite`
//      edge function with action:"link" — which matches the auth'd
//      email to a caregivers.email and populates user_id. This is
//      the first-login path for users who weren't pre-linked by the
//      admin invite flow.
//   4. On auth state change (login / logout), repeat.
//
// Returned shape:
//   { loading, session, caregiver, linkError, refresh }

export function useCaregiverSession() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [caregiver, setCaregiver] = useState(null);
  const [linkError, setLinkError] = useState(null);

  const loadLinked = useCallback(async (uid) => {
    setLinkError(null);
    const { data: cg } = await supabase
      .from('caregivers')
      .select('id, first_name, last_name, email, phone')
      .eq('user_id', uid)
      .maybeSingle();
    if (cg) {
      setCaregiver(cg);
      return;
    }
    // Not linked yet — try to self-link via edge function.
    try {
      const { data, error } = await supabase.functions.invoke('caregiver-invite', {
        body: { action: 'link' },
      });
      if (error) {
        // supabase-js surfaces a generic "Edge Function returned a non-2xx
        // status code" message. The actual error payload lives on
        // error.context — unwrap it so the user sees the real reason.
        let msg = error.message;
        try {
          const body = await error.context?.json?.();
          if (body?.error) msg = body.error;
        } catch (_) { /* fall through to generic */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      const { data: cg2 } = await supabase
        .from('caregivers')
        .select('id, first_name, last_name, email, phone')
        .eq('user_id', uid)
        .maybeSingle();
      setCaregiver(cg2 || null);
      if (!cg2) setLinkError('Linked but could not load your caregiver record.');
    } catch (e) {
      setLinkError(e?.message || 'Could not link this login to a caregiver record.');
      setCaregiver(null);
    }
  }, []);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      if (cancelled) return;
      setSession(s);
      if (s?.user?.id) await loadLinked(s.user.id);
      if (!cancelled) setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, s) => {
      if (cancelled) return;
      setSession(s);
      if (s?.user?.id) {
        await loadLinked(s.user.id);
      } else {
        setCaregiver(null);
        setLinkError(null);
      }
    });

    return () => {
      cancelled = true;
      subscription?.unsubscribe?.();
    };
  }, [loadLinked]);

  const refresh = useCallback(async () => {
    if (session?.user?.id) await loadLinked(session.user.id);
  }, [session, loadLinked]);

  return { loading, session, caregiver, linkError, refresh };
}
