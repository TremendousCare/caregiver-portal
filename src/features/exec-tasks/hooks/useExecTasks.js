import { useCallback, useEffect, useState } from 'react';
import { supabase, getOrgClaims } from '../../../lib/supabase';
import {
  fetchTasks,
  createAdHocTask,
  completeTask as completeTaskQuery,
  snoozeTask as snoozeTaskQuery,
  cancelTask as cancelTaskQuery,
  reopenTask as reopenTaskQuery,
} from '../lib/tasksQueries';

export function useExecTasks(status) {
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await fetchTasks(supabase, { status });
    if (r.error) {
      setError(r.error);
      setTasks([]);
    } else {
      setTasks(r.data ?? []);
    }
    setLoading(false);
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const runMutation = useCallback(async (fn) => {
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { orgId } = getOrgClaims(session);
      const completedBy = session?.user?.email || 'unknown';
      const result = await fn({ orgId, completedBy, session });
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

  const createTask = useCallback((draft) =>
    runMutation(({ orgId }) => createAdHocTask(supabase, { orgId, draft })),
  [runMutation]);

  const completeTask = useCallback((id, payload) =>
    runMutation(({ completedBy }) => completeTaskQuery(supabase, {
      id, completedBy, ...payload,
    })),
  [runMutation]);

  const snoozeTask = useCallback((id, snoozedUntil) =>
    runMutation(() => snoozeTaskQuery(supabase, { id, snoozedUntil })),
  [runMutation]);

  const cancelTask = useCallback((id, reason) =>
    runMutation(() => cancelTaskQuery(supabase, { id, reason })),
  [runMutation]);

  const reopenTask = useCallback((id) =>
    runMutation(() => reopenTaskQuery(supabase, { id })),
  [runMutation]);

  return { loading, submitting, tasks, error, refresh: load, createTask, completeTask, snoozeTask, cancelTask, reopenTask };
}
