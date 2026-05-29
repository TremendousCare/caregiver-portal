import { useCallback, useState } from 'react';
import { supabase, getOrgClaims } from '../../../lib/supabase';
import {
  buildMileageRow,
  validateMileageDraft,
  DEFAULT_MILEAGE_RATE_CENTS,
} from '../lib/bdMileage';
import { useBdViewAs } from '../context/BdViewAsContext';
import { ViewAsReadOnlyError } from '../lib/bdViewAs';

// Wraps the bd_mileage_entries insert + update paths, pulling
// org_id, user_id, and the display name from the live Supabase
// session. Returns { submitting, error, save, remove }.
//
// `save(draft, entryId?)` returns the inserted / updated row or
// throws. `remove(entryId)` deletes a draft and returns true (RLS
// blocks deleting a non-draft).
export function useBdLogMileage() {
  const { isReadOnly } = useBdViewAs();
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState(null);

  const save = useCallback(async (draft, entryId = null) => {
    if (isReadOnly) { const e = new ViewAsReadOnlyError(); setError(e); throw e; }
    setSubmitting(true);
    setError(null);
    try {
      const validation = validateMileageDraft(draft);
      if (!validation.ok) throw new Error(validation.error);

      const { data: { session } } = await supabase.auth.getSession();
      const { orgId } = getOrgClaims(session);
      const userId = session?.user?.id ?? null;
      const createdBy =
        session?.user?.user_metadata?.full_name
        || session?.user?.email
        || 'BD Portal';

      if (!orgId)  throw new Error('Missing org_id from session — sign out and back in.');
      if (!userId) throw new Error('Missing user id from session — sign out and back in.');

      const row = buildMileageRow(draft, { orgId, userId, createdBy });

      if (entryId) {
        // Don't overwrite immutable provenance on update.
        const { org_id: _o, user_id: _u, created_by: _c, ...patch } = row;
        const { data, error: updateErr } = await supabase
          .from('bd_mileage_entries')
          .update(patch)
          .eq('id', entryId)
          .select()
          .maybeSingle();
        if (updateErr) throw updateErr;
        return data;
      }

      const { data, error: insertErr } = await supabase
        .from('bd_mileage_entries')
        .insert(row)
        .select()
        .maybeSingle();
      if (insertErr) throw insertErr;
      return data;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, [isReadOnly]);

  const remove = useCallback(async (entryId) => {
    if (!entryId) return false;
    if (isReadOnly) { const e = new ViewAsReadOnlyError(); setError(e); throw e; }
    setSubmitting(true);
    setError(null);
    try {
      const { error: delErr } = await supabase
        .from('bd_mileage_entries')
        .delete()
        .eq('id', entryId);
      if (delErr) throw delErr;
      return true;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, [isReadOnly]);

  return { submitting, error, save, remove };
}

// Reads the org's preferred default mileage rate (cents per mile)
// from organizations.settings.mileage.default_rate_cents_per_mile.
// Falls back to the IRS standard rate constant if the setting is
// missing or malformed. Doing the lookup here (rather than in the
// migration as a hard-coded default) keeps the rate org-configurable
// per the SaaS retrofit Prime Directive #5.
export async function fetchOrgMileageRate() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const { orgId } = getOrgClaims(session);
    if (!orgId) return DEFAULT_MILEAGE_RATE_CENTS;
    const { data, error } = await supabase
      .from('organizations')
      .select('settings')
      .eq('id', orgId)
      .maybeSingle();
    if (error || !data) return DEFAULT_MILEAGE_RATE_CENTS;
    const raw = data.settings?.mileage?.default_rate_cents_per_mile;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1000) return Math.round(n);
    return DEFAULT_MILEAGE_RATE_CENTS;
  } catch {
    return DEFAULT_MILEAGE_RATE_CENTS;
  }
}
