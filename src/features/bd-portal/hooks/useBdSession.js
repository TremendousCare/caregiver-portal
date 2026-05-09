import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';

// Mirrors useCaregiverSession's shape (loading / session) but for the
// BD portal. We deliberately reuse the owner's existing portal login
// — there's no separate BD auth in Phase 1.
export function useBdSession() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return undefined;
    }

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null);
    });

    return () => subscription?.unsubscribe?.();
  }, []);

  return { loading, session };
}
