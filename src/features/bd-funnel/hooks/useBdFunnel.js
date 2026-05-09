import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import {
  fetchBdFunnelData,
  computeFunnel,
  rankAccountsByPipeline,
  lossReasonBreakdown,
  coldAccounts,
  periodStart,
} from '../lib/funnelQueries';
import { fetchBdGoals, findActiveGoal, progressVsTarget } from '../../bd-goals/lib/goalsQueries';

// Loads all the data the funnel report needs, then derives every
// view (top-level, by account, lost reasons, cold) from a single
// in-memory snapshot. Switching the period is purely client-side —
// no refetch.
export function useBdFunnel(initialPeriod = 'month') {
  const [period, setPeriod]       = useState(initialPeriod);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [snapshot, setSnapshot]   = useState({ accounts: [], activities: [], referrals: [] });
  const [goals, setGoals]         = useState([]);
  const [assigneeEmail, setAssigneeEmail] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Pull a year of data so the period selector can switch without a
    // refetch. 365d × ~340 activities/year = trivially small payload.
    const since = periodStart('year');
    const [funnelRes, goalsRes, sessionRes] = await Promise.all([
      fetchBdFunnelData(supabase, { since }),
      fetchBdGoals(supabase),
      supabase?.auth.getSession() ?? Promise.resolve({ data: { session: null } }),
    ]);
    if (funnelRes.error) {
      setError(funnelRes.error);
      setSnapshot({ accounts: [], activities: [], referrals: [] });
    } else {
      setSnapshot(funnelRes.data);
    }
    setGoals(goalsRes.data ?? []);
    setAssigneeEmail(sessionRes?.data?.session?.user?.email ?? '');
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const derived = useMemo(() => {
    const { accounts, activities, referrals } = snapshot;
    const funnel = computeFunnel(activities, referrals, period);
    // Map the funnel period to the goal period: the user-facing "week"
    // option overlays the weekly goal; "month" overlays monthly.
    // 90d / 365d periods don't have a matching goal — overlay returns
    // null target.
    const goalPeriod = period === 'week' ? 'weekly' : period === 'month' ? 'monthly' : null;
    const goal = goalPeriod && assigneeEmail
      ? findActiveGoal(goals, { period: goalPeriod, assigneeEmail })
      : null;
    return {
      funnel,
      ranked:     rankAccountsByPipeline(accounts, activities, referrals, period),
      lostReasons: lossReasonBreakdown(referrals, period),
      cold:       coldAccounts(accounts),
      goal,
      progress: {
        visits:    progressVsTarget(funnel.visits,    goal?.visits_target    ?? null),
        referrals: progressVsTarget(funnel.referrals, goal?.referrals_target ?? null),
        socs:      progressVsTarget(funnel.socs,      goal?.soc_target       ?? null),
      },
    };
  }, [snapshot, period, goals, assigneeEmail]);

  return {
    loading,
    error,
    period,
    setPeriod,
    accounts:   snapshot.accounts,
    activities: snapshot.activities,
    referrals:  snapshot.referrals,
    ...derived,
    refresh: load,
  };
}
