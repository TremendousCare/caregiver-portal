import { useCallback, useState } from 'react';
import { supabase, getOrgClaims } from '../../../lib/supabase';
import { createContact } from '../lib/bdMutations';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';

// Wraps the bd-extract-card edge function call. Returns { extracting,
// error, extract } where extract(blob) returns the structured
// contact JSON, or null when Claude reports the card is unreadable.
export function useBdExtractCard() {
  const [extracting, setExtracting] = useState(false);
  const [error, setError]           = useState(null);

  const extract = useCallback(async (blob) => {
    if (!supabase || !SUPABASE_URL) {
      throw new Error('Supabase not configured.');
    }
    setExtracting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');
      const form = new FormData();
      form.append('file', blob, `card.${(blob.type || 'image/jpeg').split('/')[1].split(';')[0]}`);
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/bd-extract-card`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(j?.error ?? `Extraction failed (${resp.status})`);
      }
      if (!j.ok) {
        throw new Error(j?.reason ?? 'Could not read the card.');
      }
      return j.contact ?? null;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setExtracting(false);
    }
  }, []);

  return { extracting, error, extract };
}

// Wraps createContact, pulling org_id and createdBy from session.
export function useBdLogContact() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState(null);

  const submit = useCallback(async (draft) => {
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { orgId } = getOrgClaims(session);
      const createdBy =
        session?.user?.user_metadata?.full_name
        || session?.user?.email
        || 'BD Portal';
      const result = await createContact(supabase, { orgId, draft, createdBy });
      if (result.error) throw result.error;
      return result;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, []);

  return { submitting, error, submit };
}
