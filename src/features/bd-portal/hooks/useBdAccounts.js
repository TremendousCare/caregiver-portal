import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { fetchAccountsWithActivity, fetchCurrentUserTerritoryCities } from '../lib/bdQueries';

// Loads BD accounts with activity counts plus the current user's
// territory city list. Consumers apply `filterToTerritory(accounts,
// territoryCities)` to default-scope their view to the rep's territory
// ∪ strategic-shared accounts; pass an empty array there to opt back
// into the org-wide view.
export function useBdAccounts() {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [activities, setActivities] = useState([]);
  const [territoryCities, setTerritoryCities] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [accountsRes, citiesRes] = await Promise.all([
      fetchAccountsWithActivity(supabase),
      fetchCurrentUserTerritoryCities(supabase),
    ]);
    if (accountsRes.error) {
      setError(accountsRes.error);
      setAccounts([]);
      setActivities([]);
    } else {
      setAccounts(accountsRes.data ?? []);
      setActivities(accountsRes._allActivities ?? []);
    }
    // Territory fetch failures are non-fatal: we just default to
    // "show everything" so the rep is never locked out of the app
    // by a transient RPC error.
    setTerritoryCities(citiesRes.error ? [] : (citiesRes.data ?? []));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { loading, accounts, activities, territoryCities, error, refresh: load };
}
