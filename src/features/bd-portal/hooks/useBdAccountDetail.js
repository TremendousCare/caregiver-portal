import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import {
  fetchAccount,
  fetchAccountContacts,
  fetchAccountActivities,
} from '../lib/bdQueries';

// Loads everything the Account profile screen needs in one shot.
// All three reads are issued in parallel — the slowest determines the
// latency, not the sum.
export function useBdAccountDetail(accountId) {
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [activities, setActivities] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    const [a, c, x] = await Promise.all([
      fetchAccount(supabase, accountId),
      fetchAccountContacts(supabase, accountId),
      fetchAccountActivities(supabase, accountId),
    ]);
    const firstErr = a.error || c.error || x.error;
    if (firstErr) {
      setError(firstErr);
      setAccount(null);
      setContacts([]);
      setActivities([]);
    } else {
      setAccount(a.data ?? null);
      setContacts(c.data ?? []);
      setActivities(x.data ?? []);
    }
    setLoading(false);
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  return { loading, account, contacts, activities, error, refresh: load };
}
