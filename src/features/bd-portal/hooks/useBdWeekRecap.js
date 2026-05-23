import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { getWeekRange, addDaysIso } from '../lib/bdWeekRecap';

// Loads the BD rep's route plans and logged activities for the Mon–Sun
// week containing `weekDate` (a Date object, defaults to today).
//
// Activities are scoped to the current user via `created_by`, matching
// how useBdLogActivity writes them (display name OR email, whichever
// the session exposes). One rep today, but the filter is in place so
// the recap stays "my week" once additional reps join.
//
// Route plans are scoped via `owner_user_id` (already enforced by RLS,
// re-asserted in the query for clarity).
export function useBdWeekRecap(weekDate) {
  const [loading,    setLoading]    = useState(true);
  const [plans,      setPlans]      = useState([]);
  const [activities, setActivities] = useState([]);
  const [error,      setError]      = useState(null);

  const range = getWeekRange(weekDate ?? new Date());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user?.id) {
      setPlans([]);
      setActivities([]);
      setLoading(false);
      return;
    }
    // We filter activities by `created_by` matching either the user's
    // display name or email. useBdLogActivity prefers full_name and
    // falls back to email, so accepting both covers any historical
    // rows logged before/after a metadata change.
    const createdByCandidates = [
      user.user_metadata?.full_name,
      user.email,
    ].filter(Boolean);

    // Week activities span the full last day, so the upper bound is
    // exclusive at the start of the next day.
    const weekEndExclusive = addDaysIso(range.end, 1);

    const [plansRes, activitiesRes] = await Promise.all([
      supabase
        .from('bd_route_plans')
        .select('id, plan_date, name, stops, status, updated_at')
        .eq('owner_user_id', user.id)
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
  }, [range.start, range.end]);

  useEffect(() => { load(); }, [load]);

  return { loading, range, plans, activities, error, refresh: load };
}
