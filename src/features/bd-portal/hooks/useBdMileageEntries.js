import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useBdViewAs } from '../context/BdViewAsContext';

// Loads the effective rep's mileage entries. Normally that's the
// signed-in user (RLS scopes to user_id = auth.uid()); when an owner is
// auditing a rep it's that rep's id, surfaced via the owner read-override
// SELECT policy. Returns the same { loading, entries, error, refresh,
// userId } shape used by the other BD list hooks so the components stay
// consistent. `userId` is the effective user so callers' editability
// checks line up with the rows shown.
//
// The explicit user_id filter is load-bearing: with the owner override
// policy an unfiltered query would return every rep's mileage merged.
//
// `limit` caps how many rows we pull; the form is mobile and the
// list is meant for "this month and recent history," not paginated
// archive.
export function useBdMileageEntries({ limit = 200 } = {}) {
  const { effectiveUserId } = useBdViewAs();
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState([]);
  const [error,   setError]   = useState(null);
  const [userId,  setUserId]  = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUserId(effectiveUserId);
      // No effective user yet (session still resolving) — don't fetch, or
      // an owner would briefly see the whole org's mileage merged.
      if (!effectiveUserId) {
        setEntries([]);
        setLoading(false);
        return;
      }

      const { data, error: queryErr } = await supabase
        .from('bd_mileage_entries')
        .select(`
          id, org_id, user_id, trip_date, started_at, ended_at,
          odometer_start, odometer_end, miles, source,
          start_location, end_location,
          purpose, is_round_trip,
          account_id, activity_id,
          rate_cents_per_mile, reimbursement_cents,
          status, submitted_at,
          notes, created_by, created_at, updated_at,
          account:bd_accounts ( id, name, city )
        `)
        .eq('user_id', effectiveUserId)
        .order('trip_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(limit);

      if (queryErr) throw queryErr;
      setEntries(data ?? []);
    } catch (e) {
      setError(e);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [limit, effectiveUserId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { loading, entries, userId, error, refresh };
}

// Loads a single mileage entry by id. Same RLS — rep only sees their
// own. Returns null when not found (or hidden by RLS).
export function useBdMileageEntry(entryId) {
  const [loading, setLoading] = useState(!!entryId);
  const [entry,   setEntry]   = useState(null);
  const [error,   setError]   = useState(null);

  const refresh = useCallback(async () => {
    if (!entryId) {
      setEntry(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryErr } = await supabase
        .from('bd_mileage_entries')
        .select(`
          id, org_id, user_id, trip_date, started_at, ended_at,
          odometer_start, odometer_end, miles, source,
          start_location, end_location, start_lat, start_lng, end_lat, end_lng,
          purpose, is_round_trip,
          account_id, activity_id,
          rate_cents_per_mile, reimbursement_cents,
          status, submitted_at,
          notes, created_by, created_at, updated_at
        `)
        .eq('id', entryId)
        .maybeSingle();
      if (queryErr) throw queryErr;
      setEntry(data ?? null);
    } catch (e) {
      setError(e);
      setEntry(null);
    } finally {
      setLoading(false);
    }
  }, [entryId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { loading, entry, error, refresh };
}
