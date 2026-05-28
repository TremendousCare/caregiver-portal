import { useCallback, useEffect, useState } from 'react';
import { supabase, getOrgClaims } from '../../../lib/supabase';
import {
  fetchStaff,
  createStaff as createStaffQuery,
  updateStaff as updateStaffQuery,
  deactivateStaff as deactivateStaffQuery,
  deleteStaff as deleteStaffQuery,
} from '../lib/staffQueries';

export function useExecStaff() {
  const [loading, setLoading]       = useState(true);
  const [staff, setStaff]           = useState([]);
  const [error, setError]           = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await fetchStaff(supabase, { includeInactive: true });
    if (r.error) {
      setError(r.error);
      setStaff([]);
    } else {
      setStaff(r.data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const runMutation = useCallback(async (fn) => {
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { orgId } = getOrgClaims(session);
      const result = await fn({ orgId, session });
      if (result?.error) throw result.error;
      await load();
      return result?.data ?? null;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, [load]);

  const createStaff = useCallback((draft) =>
    runMutation(({ orgId }) => createStaffQuery(supabase, { orgId, draft })),
  [runMutation]);

  const updateStaff = useCallback((id, patch) =>
    runMutation(() => updateStaffQuery(supabase, { id, patch })),
  [runMutation]);

  const deactivateStaff = useCallback((id, endDate) =>
    runMutation(() => deactivateStaffQuery(supabase, { id, endDate })),
  [runMutation]);

  const deleteStaff = useCallback((id) =>
    runMutation(() => deleteStaffQuery(supabase, id)),
  [runMutation]);

  return {
    loading, submitting, staff, error,
    refresh: load,
    createStaff, updateStaff, deactivateStaff, deleteStaff,
  };
}
