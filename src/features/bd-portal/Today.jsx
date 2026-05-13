import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Map } from 'lucide-react';
import { useBdAccounts } from './hooks/useBdAccounts';
import { useBdBriefing } from './hooks/useBdBriefing';
import { useBdNearbyAccount } from './hooks/useBdNearbyAccount';
import {
  rankAccounts,
  summarizeWeek,
  daysSince,
  buildAppleMapsRouteUrl,
  hasRoutableAddress,
  filterToTerritory,
} from './lib/bdQueries';
import { fetchBdGoals, findActiveGoal, progressVsTarget } from '../bd-goals/lib/goalsQueries';
import { supabase } from '../../lib/supabase';
import s from './BdPortal.module.css';

function timeOfDayGreeting(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatDays(d) {
  if (d === null || d === undefined) return 'never visited';
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d}d ago`;
}

export function Today({ displayName }) {
  const navigate = useNavigate();
  const { loading: accountsLoading, accounts, activities, territoryCities, error: accountsError, refresh: refreshAccounts } = useBdAccounts();
  const { loading: briefingLoading, briefing, refresh: refreshBriefing } = useBdBriefing(displayName);

  // Top-5 suggestions are scoped to the rep's territory ∪ strategic
  // accounts; if they have no territory configured this no-ops and
  // they see the org-wide list. Week counters intentionally use the
  // unfiltered activity slice so the rep's out-of-territory work still
  // counts toward their numbers.
  const territoryAccounts = useMemo(
    () => filterToTerritory(accounts, territoryCities),
    [accounts, territoryCities],
  );

  const week = useMemo(() => summarizeWeek(activities), [activities]);
  const top = useMemo(() => rankAccounts(territoryAccounts).slice(0, 5), [territoryAccounts]);

  // Geofence prompt. No-op if accounts lack lat/lng or location is
  // denied — the rep can still log activity through the normal flow.
  const { nearest } = useBdNearbyAccount(accounts);

  // Active weekly goal overlay. Best-effort — if it fails or there's
  // no goal yet, the counters render without the "/ target" suffix.
  const [weeklyGoal, setWeeklyGoal] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const email = session?.user?.email;
      if (!email) return;
      const { data: goals } = await fetchBdGoals(supabase);
      if (cancelled) return;
      setWeeklyGoal(findActiveGoal(goals, { period: 'weekly', assigneeEmail: email }));
    })();
    return () => { cancelled = true; };
  }, []);

  // Briefing wins when present; otherwise fall back to the local
  // counters/list. The Today screen never blocks waiting on Claude.
  const greeting = briefing?.greeting
    ?? `${timeOfDayGreeting()}${displayName ? `, ${displayName}` : ''}`;
  const narrative = briefing?.narrative;
  const stats = briefing?.stats;
  const weekStats = stats?.week ?? week;

  // Briefing-returned suggestions come from the edge function, which
  // currently ranks the full org account list — that bypasses the
  // territory filter applied to `top`. Intersect with the territory
  // slice so the rep's Top 5 (and the multi-stop route built from it)
  // stays scoped to South OC ∪ strategic regardless of whether the
  // briefing or the local fallback is rendering. No-ops when the rep
  // has no territory configured. Pushing the filter server-side into
  // bd-briefing is a follow-up.
  const territoryAccountIds = useMemo(
    () => new Set(territoryAccounts.map((a) => a.id)),
    [territoryAccounts],
  );
  const suggested = useMemo(() => {
    const raw = Array.isArray(briefing?.suggested_visits)
      ? briefing.suggested_visits
      : top;
    if (territoryCities.length === 0) return raw;
    return raw.filter((s) => territoryAccountIds.has(s.account_id ?? s.id));
  }, [briefing, top, territoryCities, territoryAccountIds]);

  // Hydrate suggested stops with their account row so we have the
  // address for the route URL. Briefing returns lightweight refs
  // (id/name/days_since); we look up the full account record.
  const routeStops = useMemo(() => {
    if (!Array.isArray(suggested) || !Array.isArray(accounts)) return [];
    return suggested
      .map((s) => {
        const id = s.account_id ?? s.id;
        return accounts.find((a) => a.id === id) ?? null;
      })
      .filter(Boolean)
      .filter(hasRoutableAddress)
      .slice(0, 5);
  }, [suggested, accounts]);

  const routeUrl = useMemo(
    () => (routeStops.length >= 2 ? buildAppleMapsRouteUrl(routeStops) : null),
    [routeStops],
  );

  function handleRefresh() {
    refreshAccounts();
    refreshBriefing();
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <p className={s.greeting}>{greeting}</p>
          <h1 className={s.pageTitle}>Today</h1>
        </div>
        <button type="button" className={s.signOutBtn} onClick={handleRefresh}>Refresh</button>
      </div>

      {accountsError && (
        <div className={s.error}>Couldn&rsquo;t load accounts: {accountsError.message}</div>
      )}

      {nearest?.account && (
        <button
          type="button"
          className={s.nearbyBanner}
          onClick={() => navigate(`/bd/accounts/${nearest.account.id}/log`)}
        >
          <div className={s.nearbyIcon} aria-hidden><MapPin size={22} strokeWidth={2} /></div>
          <div className={s.nearbyBody}>
            <div className={s.nearbyTitle}>Looks like you&rsquo;re at {nearest.account.name}</div>
            <div className={s.nearbySubtitle}>Tap to log a visit</div>
          </div>
        </button>
      )}

      <div className={s.card}>
        <div className={s.sectionTitle}>Briefing</div>
        {briefingLoading && !briefing ? (
          <p className={s.briefingText}>Drafting your briefing…</p>
        ) : narrative ? (
          <p className={s.briefingText}>{narrative}</p>
        ) : accountsLoading ? (
          <p className={s.briefingText}>Loading your accounts…</p>
        ) : accounts.length === 0 ? (
          <p className={s.briefingText}>No accounts yet. Run the Trello import to get started.</p>
        ) : (
          <p className={s.briefingText}>
            You have {territoryAccounts.length} accounts in your territory.
            {stats?.cold_count ? ` ${stats.cold_count} are cold (>21 days no contact).` : ''}
          </p>
        )}
      </div>

      <div className={s.card}>
        <div className={s.sectionTitle}>This week</div>
        <div className={s.counters}>
          <div className={s.counter}>
            <div className={s.counterValue}>
              {weekStats.visits}
              {weeklyGoal?.visits_target ? <span className={s.counterTarget}> / {weeklyGoal.visits_target}</span> : null}
            </div>
            <div className={s.counterLabel}>
              {progressVsTarget(weekStats.visits, weeklyGoal?.visits_target ?? null).label ?? 'visits'}
            </div>
          </div>
          <div className={s.counter}>
            <div className={s.counterValue}>{weekStats.calls}</div>
            <div className={s.counterLabel}>calls</div>
          </div>
          <div className={s.counter}>
            <div className={s.counterValue}>{weekStats.drop_offs ?? weekStats.dropOffs ?? 0}</div>
            <div className={s.counterLabel}>drop-offs</div>
          </div>
        </div>
      </div>

      <div className={s.card}>
        <div className={s.routeHeader}>
          <div className={s.sectionTitle}>Top 5 to visit next</div>
          {routeUrl && (
            <a
              className={s.routeBtn}
              href={routeUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Map size={14} aria-hidden />
              <span>Plan route ({routeStops.length})</span>
            </a>
          )}
        </div>
        {accountsLoading && !suggested.length ? (
          <p className={s.muted}>Loading…</p>
        ) : suggested.length === 0 ? (
          <p className={s.empty}>No accounts yet.</p>
        ) : (
          <div className={s.accountList}>
            {suggested.slice(0, 5).map((a) => {
              const id = a.account_id ?? a.id;
              const days = a.days_since_activity ?? a._days_since ?? daysSince(a.last_activity_at);
              const cold = a.cold ?? a._cold ?? (days === null || days >= 21);
              const activityCount = a.activity_count ?? null;
              return (
                <button
                  key={id}
                  type="button"
                  className={`${s.accountCard} ${cold ? s.accountCardCold : ''}`}
                  onClick={() => navigate(`/bd/accounts/${id}`)}
                >
                  <div>
                    <div className={s.accountName}>
                      {a.name}
                      {cold && <span className={`${s.tag} ${s.tagCold}`}>cold</span>}
                    </div>
                    <div className={s.accountMeta}>
                      {a.city ?? '—'}{activityCount !== null ? ` · ${activityCount} activities` : ''}
                    </div>
                  </div>
                  <div className={s.lastSeen}>{formatDays(days)}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
