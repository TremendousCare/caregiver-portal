import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { fetchAccountsWithActivity } from '../lib/bdQueries';

// Loads BD accounts with activity counts and the full activity slice
// used by the Today screen for week summaries. Re-fetches on `refresh()`.
export function useBdAccounts() {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [activities, setActivities] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await fetchAccountsWithActivity(supabase);
    if (r.error) {
      setError(r.error);
      setAccounts([]);
      setActivities([]);
    } else {
      setAccounts(r.data ?? []);
      setActivities(r._allActivities ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { loading, accounts, activities, error, refresh: load };
}
