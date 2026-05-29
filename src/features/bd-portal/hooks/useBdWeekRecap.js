import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { getWeekRange, addDaysIso } from '../lib/bdWeekRecap';
import { useBdViewAs } from '../context/BdViewAsContext';

// Loads the BD rep's route plans and logged activities for the Mon–Sun
// week containing `weekDate` (a Date object, defaults to today).
//
// Identity is the *effective* rep from BdViewAsContext: the signed-in
// user normally, or the rep an owner is auditing while viewing-as. Route
// plans are scoped by `owner_user_id`; activities by `created_by`
// (display name OR email — matching how useBdLogActivity writes them).
// When an owner is viewing-as, owner-as-admin RLS lets them read the
// rep's plans, and bd_activities is org-readable, so the recap mirrors
// the audited rep faithfully.
export function useBdWeekRecap(weekDate) {
  const { effectiveUserId, isViewingAs, effectiveRep } = useBdViewAs();
  const [loading,    setLoading]    = useState(true);
  const [plans,      setPlans]      = useState([]);
  const [activities, setActivities] = useState([]);
  const [error,      setError]      = useState(null);

  const range = getWeekRange(weekDate ?? new Date());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: { session } } = await supabase.auth.getSession();
    const sessionUser = session?.user;

    // Effective identity: the audited rep when viewing-as, else self.
    const ownerUserId = isViewingAs ? effectiveUserId : sessionUser?.id;
    if (!ownerUserId) {
      setPlans([]);
      setActivities([]);
      setLoading(false);
      return;
    }
    // We filter activities by `created_by` matching either the rep's
    // display name or email. useBdLogActivity prefers full_name and
    // falls back to email, so accepting both covers any historical
    // rows logged before/after a metadata change. When viewing-as we
    // use the audited rep's name/email (from the auditable-reps RPC).
    const createdByCandidates = (isViewingAs
      ? [effectiveRep?.full_name, effectiveRep?.email]
      : [sessionUser?.user_metadata?.full_name, sessionUser?.email]
    ).filter(Boolean);

    // Week activities span the full last day, so the upper bound is
    // exclusive at the start of the next day.
    const weekEndExclusive = addDaysIso(range.end, 1);

    const [plansRes, activitiesRes] = await Promise.all([
      supabase
        .from('bd_route_plans')
        .select('id, plan_date, name, stops, status, updated_at')
        .eq('owner_user_id', ownerUserId)
        .eq('status', 'active')
        .gte('plan_date', range.start)
        .lte('plan_date', range.end),
      supabase
        .from('bd_activities')
        .select('id, account_id, contact_id, activity_type, occurred_at, notes, spend_cents, spend_category, source, created_by')
        .gte('occurred_at', `${range.start}T00:00:00`)
        .lt('occurred_at',  `${weekEndExclusive}T00:00:00`)
        .in('created_by', createdByCandidates.length > 0 ? createdByCandidates : ['__none__'])
        .order('occurred_at', { ascending: true }),
    ]);

    if (plansRes.error) {
      setError(plansRes.error);
      setPlans([]);
    } else {
      setPlans(plansRes.data ?? []);
    }
    if (activitiesRes.error) {
      setError((prev) => prev ?? activitiesRes.error);
      setActivities([]);
    } else {
      setActivities(activitiesRes.data ?? []);
    }
    setLoading(false);
    // We intentionally serialize the dependency on `weekDate` via the
    // computed ISO range rather than the Date object reference, so a
    // re-render with the same week doesn't trigger a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end, isViewingAs, effectiveUserId, effectiveRep]);

  useEffect(() => { load(); }, [load]);

  return { loading, range, plans, activities, error, refresh: load };
}
