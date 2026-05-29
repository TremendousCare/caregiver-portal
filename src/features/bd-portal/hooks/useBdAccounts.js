import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { fetchAccountsWithActivity, fetchTerritoryCitiesForUser } from '../lib/bdQueries';
import { useBdViewAs } from '../context/BdViewAsContext';

// Loads BD accounts with activity counts plus the effective user's
// territory city list. Consumers apply `filterToTerritory(accounts,
// territoryCities)` to default-scope their view to the rep's territory
// ∪ strategic-shared accounts; pass an empty array there to opt back
// into the org-wide view.
//
// The territory list is keyed off the *effective* user from
// BdViewAsContext — the signed-in rep in the normal case, or the rep an
// owner is auditing while viewing-as — so the Today/Accounts screens
// mirror that rep's territory scope. Accounts themselves are org-scoped
// by RLS, so only the city filter changes.
export function useBdAccounts() {
  const { effectiveUserId } = useBdViewAs();
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [activities, setActivities] = useState([]);
  const [territoryCities, setTerritoryCities] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    // Wait for the effective user to resolve before fetching. It comes
    // from the local session (fast), so this is a sub-tick wait — and it
    // avoids fetching the full accounts + activities list twice (once
    // with a null id, then again when the id resolves) on every mount.
    if (!effectiveUserId) return;
    setLoading(true);
    setError(null);
    const [accountsRes, citiesRes] = await Promise.all([
      fetchAccountsWithActivity(supabase),
      fetchTerritoryCitiesForUser(supabase, effectiveUserId),
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
  }, [effectiveUserId]);

  useEffect(() => { load(); }, [load]);

  return { loading, accounts, activities, territoryCities, error, refresh: load };
}
