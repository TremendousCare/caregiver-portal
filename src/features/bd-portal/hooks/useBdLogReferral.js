import { useCallback, useState } from 'react';
import { supabase, getOrgClaims } from '../../../lib/supabase';
import { createReferral } from '../lib/bdMutations';

// Wraps createReferral, pulling org_id and the user display name from
// the live supabase session. Returns { submitting, error, submit }
// where submit({draft, accountName, contactName}) returns the
// { client, referral } pair or throws.
export function useBdLogReferral() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState(null);

  const submit = useCallback(async ({ draft, accountName, contactName }) => {
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { orgId } = getOrgClaims(session);
      const createdBy =
        session?.user?.user_metadata?.full_name
        || session?.user?.email
        || 'BD Portal';
      const { data, error: createErr } = await createReferral(supabase, {
        orgId,
        draft,
        createdBy,
        accountName,
        contactName,
      });
      if (createErr) throw createErr;
      return data;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, []);

  return { submitting, error, submit };
}
