// React hook backing the Executive Goals page. Loads goals + nested
// KRs + nested check-ins for the selected quarter; exposes mutation
// helpers that auto-refresh after each write.

import { useCallback, useEffect, useState } from 'react';
import { supabase, getOrgClaims } from '../../../lib/supabase';
import {
  fetchGoalsForQuarter,
  createGoal as createGoalQuery,
  updateGoal as updateGoalQuery,
  deleteGoal as deleteGoalQuery,
  createKr as createKrQuery,
  updateKr as updateKrQuery,
  deleteKr as deleteKrQuery,
  upsertCheckin as upsertCheckinQuery,
} from '../lib/goalsQueries';

export function useExecGoals(quarter) {
  const [loading, setLoading]       = useState(true);
  const [goals, setGoals]           = useState([]);
  const [error, setError]           = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await fetchGoalsForQuarter(supabase, quarter);
    if (r.error) {
      setError(r.error);
      setGoals([]);
    } else {
      setGoals(r.data ?? []);
    }
    setLoading(false);
  }, [quarter]);

  useEffect(() => { load(); }, [load]);

  // ─── Shared mutation wrapper ────────────────────────────────
  // Captures the org claim from the current session, calls the query,
  // refreshes on success, surfaces error to caller for inline display.
  const runMutation = useCallback(async (fn) => {
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { orgId } = getOrgClaims(session);
      const author = session?.user?.email || 'unknown';
      const result = await fn({ orgId, author, session });
      if (result?.error) throw result.error;
      await load();
      return result?.data ?? null;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, [load]);

  const createGoal = useCallback((draft) =>
    runMutation(({ orgId }) => createGoalQuery(supabase, { orgId, draft })),
  [runMutation]);

  const updateGoal = useCallback((id, patch) =>
    runMutation(() => updateGoalQuery(supabase, { id, patch })),
  [runMutation]);

  const deleteGoal = useCallback((id) =>
    runMutation(() => deleteGoalQuery(supabase, id)),
  [runMutation]);

  const createKr = useCallback((draft) =>
    runMutation(({ orgId }) => createKrQuery(supabase, { orgId, draft })),
  [runMutation]);

  const updateKr = useCallback((id, patch) =>
    runMutation(() => updateKrQuery(supabase, { id, patch })),
  [runMutation]);

  const deleteKr = useCallback((id) =>
    runMutation(() => deleteKrQuery(supabase, id)),
  [runMutation]);

  const checkinKr = useCallback((draft) =>
    runMutation(({ orgId, author }) => upsertCheckinQuery(supabase, {
      orgId,
      draft: { author, ...draft },
    })),
  [runMutation]);

  return {
    loading,
    submitting,
    goals,
    error,
    refresh: load,
    createGoal,
    updateGoal,
    deleteGoal,
    createKr,
    updateKr,
    deleteKr,
    checkinKr,
  };
}
