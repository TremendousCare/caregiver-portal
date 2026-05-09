import { useCallback, useEffect, useState } from 'react';
import { supabase, getOrgClaims } from '../../../lib/supabase';
import { fetchBdGoals, saveGoal } from '../lib/goalsQueries';

export function useBdGoals() {
  const [loading, setLoading]       = useState(true);
  const [goals, setGoals]           = useState([]);
  const [error, setError]           = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await fetchBdGoals(supabase);
    if (r.error) {
      setError(r.error);
      setGoals([]);
    } else {
      setGoals(r.data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = useCallback(async (draft) => {
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { orgId } = getOrgClaims(session);
      const createdBy =
        session?.user?.user_metadata?.full_name
        || session?.user?.email
        || 'BD Portal';
      const { data, error: saveErr } = await saveGoal(supabase, {
        orgId,
        draft,
        createdBy,
        existingGoals: goals,
      });
      if (saveErr) throw saveErr;
      await load();
      return data;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, [goals, load]);

  return { loading, goals, error, refresh: load, create, submitting };
}
