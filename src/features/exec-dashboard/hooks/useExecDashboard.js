// Dashboard hook: parallel-load goals + tasks for the current
// quarter, gracefully degrading when the tasks read is denied by RLS
// (admin viewers). The page renders task widgets only when tasks
// fetch successfully.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { fetchGoalsForQuarter } from '../../exec-goals/lib/goalsQueries';
import { fetchTasks } from '../../exec-tasks/lib/tasksQueries';
import { quarterFromDate } from '../../exec-goals/lib/goalsHelpers';

export function useExecDashboard() {
  const [loading, setLoading]       = useState(true);
  const [goals, setGoals]           = useState([]);
  const [tasks, setTasks]           = useState([]);
  const [tasksAvailable, setTasksAvailable] = useState(true);
  const [error, setError]           = useState(null);
  const [quarter, setQuarter]       = useState(() => quarterFromDate(new Date()));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Parallel loads — goals always available to admin/owner;
    // tasks only to owner. If tasks 403s we hide its widgets.
    const [goalsRes, tasksRes] = await Promise.all([
      fetchGoalsForQuarter(supabase, quarter),
      fetchTasks(supabase, { status: 'open', limit: 200 }),
    ]);
    if (goalsRes.error) {
      setError(goalsRes.error);
      setGoals([]);
    } else {
      setGoals(goalsRes.data ?? []);
    }
    if (tasksRes.error) {
      // Distinguish "denied" from real errors. Anything from RLS
      // surfaces as an error code we treat as "you can't see this";
      // a real outage we want to bubble up to the goals banner.
      const code = tasksRes.error?.code ?? '';
      const msg = tasksRes.error?.message ?? '';
      const denied = code === '42501' || /policy|permission|denied/i.test(msg);
      setTasksAvailable(!denied);
      setTasks([]);
      if (!denied && !goalsRes.error) {
        // Only surface tasks errors when goals succeeded — otherwise
        // the goals error already explains the page is broken.
        setError(tasksRes.error);
      }
    } else {
      setTasks(tasksRes.data ?? []);
      setTasksAvailable(true);
    }
    setLoading(false);
  }, [quarter]);

  useEffect(() => { load(); }, [load]);

  return {
    loading,
    goals,
    tasks,
    tasksAvailable,
    error,
    quarter,
    setQuarter,
    refresh: load,
  };
}
