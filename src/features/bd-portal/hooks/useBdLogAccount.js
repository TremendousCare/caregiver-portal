import { useCallback, useState } from 'react';
import { supabase, getOrgClaims } from '../../../lib/supabase';
import { createAccountWithContacts, findAccountDuplicates } from '../lib/bdMutations';
import { useBdViewAs } from '../context/BdViewAsContext';
import { ViewAsReadOnlyError } from '../lib/bdViewAs';

// Wraps createAccountWithContacts. Pulls org_id and createdBy from the
// authenticated session so the form doesn't have to. Returns the full
// result object — { data, duplicate, duplicates, contacts, contactErrors }
// — so the caller can branch on duplicate detection without losing the
// contact-error detail.
export function useBdLogAccount() {
  const { isReadOnly } = useBdViewAs();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState(null);

  const submit = useCallback(async ({ draft, contactDrafts = [], force = false }) => {
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
      const result = await createAccountWithContacts(supabase, {
        orgId, draft, contactDrafts, createdBy, force,
      });
      if (result.error) throw result.error;
      return result;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, [isReadOnly]);

  // Standalone duplicate lookup so the form can warn live as the rep
  // types the name (debounced), not only on submit.
  const findDuplicates = useCallback(async (name) => {
    const { data: { session } } = await supabase.auth.getSession();
    const { orgId } = getOrgClaims(session);
    const res = await findAccountDuplicates(supabase, { orgId, name });
    return res.data ?? [];
  }, []);

  return { submitting, error, submit, findDuplicates };
}
