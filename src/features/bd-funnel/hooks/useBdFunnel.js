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

// Loads all the data the funnel report needs, then derives every
// view (top-level, by account, lost reasons, cold) from a single
// in-memory snapshot. Switching the period is purely client-side —
// no refetch.
export function useBdFunnel(initialPeriod = 'month') {
  const [period, setPeriod]       = useState(initialPeriod);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [snapshot, setSnapshot]   = useState({ accounts: [], activities: [], referrals: [] });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Pull a year of data so the period selector can switch without a
    // refetch. 365d × ~340 activities/year = trivially small payload.
    const since = periodStart('year');
    const r = await fetchBdFunnelData(supabase, { since });
    if (r.error) {
      setError(r.error);
      setSnapshot({ accounts: [], activities: [], referrals: [] });
    } else {
      setSnapshot(r.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const derived = useMemo(() => {
    const { accounts, activities, referrals } = snapshot;
    return {
      funnel:     computeFunnel(activities, referrals, period),
      ranked:     rankAccountsByPipeline(accounts, activities, referrals, period),
      lostReasons: lossReasonBreakdown(referrals, period),
      cold:       coldAccounts(accounts),
    };
  }, [snapshot, period]);

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
