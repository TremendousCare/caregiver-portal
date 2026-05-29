import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import {
  todayLocalIsoDate,
  fetchActiveRoutePlan,
  createRoutePlan,
  updateRoutePlanStops,
  normalizeStops,
} from '../lib/bdRoutePlans';
import { useBdViewAs } from '../context/BdViewAsContext';
import { ViewAsReadOnlyError } from '../lib/bdViewAs';

// Loads the current rep's active route plan for today (rep's local
// timezone). If none exists, the hook does NOT auto-create one — the
// UI distinguishes "no plan yet" from "empty plan" so the Today
// screen can render a "Build today's plan" CTA when the rep hasn't
// started planning.
//
// Returns { loading, plan, planDate, error, save, ensurePlan, refresh }.
//   - save(stops): writes the stops list to the existing plan (or
//     creates a new plan if one doesn't exist yet) and returns the
//     resulting plan row. Used by the builder to persist edits.
//   - ensurePlan(): explicitly creates the plan if missing. Used by
//     the "Build today's plan" CTA so the builder screen always has
//     a plan id to write against.
export function useBdTodayPlan() {
  const { effectiveUserId, isReadOnly } = useBdViewAs();
  const [loading,  setLoading]  = useState(true);
  const [plan,     setPlan]     = useState(null);
  const [error,    setError]    = useState(null);
  const [planDate] = useState(todayLocalIsoDate());

  // The plan we render belongs to the *effective* rep — self normally,
  // or the rep an owner is auditing. Owners read a rep's plan via
  // owner-as-admin RLS; writes stay disabled while viewing-as (below).
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    let uid = effectiveUserId;
    if (!uid) {
      const { data: { user } } = await supabase.auth.getUser();
      uid = user?.id ?? null;
    }
    if (!uid) {
      setPlan(null);
      setLoading(false);
      return;
    }
    const { data, error: fetchErr } = await fetchActiveRoutePlan(supabase, uid, planDate);
    if (fetchErr) {
      setError(fetchErr);
      setPlan(null);
    } else {
      setPlan(data);
    }
    setLoading(false);
  }, [planDate, effectiveUserId]);

  useEffect(() => { load(); }, [load]);

  const ensurePlan = useCallback(async () => {
    // Never create/modify a plan while auditing another rep. An owner is
    // an admin, so RLS would otherwise let them write a plan under the
    // rep's owner_user_id — the read-only mirror must not.
    if (isReadOnly) { const e = new ViewAsReadOnlyError(); setError(e); throw e; }
    if (plan) return plan;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.id) return null;
    // Concurrent calls could race against the unique partial index.
    // On conflict we refetch and adopt the row that won — the caller
    // either way gets back an active plan for today.
    const { data, error: createErr } = await createRoutePlan(supabase, user.id, planDate);
    if (createErr) {
      const { data: existing } = await fetchActiveRoutePlan(supabase, user.id, planDate);
      if (existing) {
        setPlan(existing);
        return existing;
      }
      setError(createErr);
      return null;
    }
    setPlan(data);
    return data;
  }, [plan, planDate, isReadOnly]);

  const save = useCallback(async (rawStops) => {
    if (isReadOnly) { const e = new ViewAsReadOnlyError(); setError(e); throw e; }
    const stops = normalizeStops(rawStops);
    const target = await ensurePlan();
    if (!target) return { data: null, error: error ?? new Error('No plan to save against') };
    const { data, error: updateErr } = await updateRoutePlanStops(supabase, target.id, stops);
    if (updateErr) {
      setError(updateErr);
      return { data: null, error: updateErr };
    }
    // updateRoutePlanStops returns a slim row (id, stops, updated_at).
    // Splice the new stops into the loaded plan so the UI re-renders
    // immediately without a second fetch.
    setPlan((prev) => prev ? { ...prev, stops: data.stops, updated_at: data.updated_at } : { ...target, stops: data.stops, updated_at: data.updated_at });
    return { data, error: null };
  }, [ensurePlan, error, isReadOnly]);

  return { loading, plan, planDate, error, save, ensurePlan, refresh: load };
}
