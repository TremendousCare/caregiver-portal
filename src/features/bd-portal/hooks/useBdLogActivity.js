import { useCallback, useState } from 'react';
import { supabase, getOrgClaims } from '../../../lib/supabase';
import { insertActivity } from '../lib/bdMutations';
import { useBdViewAs } from '../context/BdViewAsContext';
import { ViewAsReadOnlyError } from '../lib/bdViewAs';

// Wraps insertActivity, pulling org_id and the user display name from
// the live supabase session. Returns { submitting, error, submit }
// where submit(draft) returns the inserted row or throws.
export function useBdLogActivity() {
  const { isReadOnly } = useBdViewAs();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState(null);

  const submit = useCallback(async (draft) => {
    if (isReadOnly) { const e = new ViewAsReadOnlyError(); setError(e); throw e; }
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { orgId } = getOrgClaims(session);
      const createdBy =
        session?.user?.user_metadata?.full_name
        || session?.user?.email
        || 'BD Portal';
      const { data, error: insertErr } = await insertActivity(supabase, {
        orgId,
        draft,
        createdBy,
      });
      if (insertErr) throw insertErr;
      return data;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, [isReadOnly]);

  return { submitting, error, submit };
}

// Best-effort GPS lookup for the "captured at" stamp. Resolves to
// { lat, lng } on success, null on permission denial / timeout / no
// API. Never throws.
export function getCurrentPosition({ timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { maximumAge: 60_000, timeout: timeoutMs },
    );
  });
}
