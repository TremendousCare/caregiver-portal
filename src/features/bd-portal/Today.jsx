import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Map, ListOrdered, Gauge } from 'lucide-react';
import { useBdAccounts } from './hooks/useBdAccounts';
import { useBdAccountStars } from './hooks/useBdAccountStars';
import { useBdViewAs } from './context/BdViewAsContext';
import { useBdBriefing } from './hooks/useBdBriefing';
import { useBdNearbyAccount } from './hooks/useBdNearbyAccount';
import { useBdTodayPlan } from './hooks/useBdTodayPlan';
import {
  rankAccounts,
  summarizeWeek,
  daysSince,
  buildAppleMapsRouteUrl,
  hasRoutableAddress,
  filterToTerritory,
  resolveBriefingIdentity,
  isCold,
} from './lib/bdQueries';
import { hydrateStops, pruneStopsAgainstAccounts } from './lib/bdRoutePlans';
import { fetchBdGoals, findActiveGoal, progressVsTarget } from '../bd-goals/lib/goalsQueries';
import { supabase } from '../../lib/supabase';
import { WeekRecap } from './WeekRecap';
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
  const { isReadOnly, isViewingAs, effectiveRep, effectiveUserId } = useBdViewAs();
  const { loading: accountsLoading, accounts, activities, territoryCities, error: accountsError, refresh: refreshAccounts } = useBdAccounts();
  const { starredIds } = useBdAccountStars();

  // The signed-in session user, resolved once. Combined with the view-as
  // context it yields the *effective* rep identity the briefing scopes to
  // — so the narrative, the week counters it cites, and the Top-5 list all
  // describe the same person (the audited rep when an owner is viewing-as).
  const [sessionUser, setSessionUser] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!cancelled) setSessionUser(session?.user ?? null);
    })();
    return () => { cancelled = true; };
  }, []);

  const briefingIdentity = useMemo(
    () => resolveBriefingIdentity({ sessionUser, isViewingAs, effectiveRep, effectiveUserId }),
    [sessionUser, isViewingAs, effectiveRep, effectiveUserId],
  );

  const { loading: briefingLoading, briefing, refresh: refreshBriefing } = useBdBriefing(briefingIdentity);
  const { plan: todayPlan, refresh: refreshPlan } = useBdTodayPlan();

  // Render-ready stops: pruned against the current accounts list (so
  // a stop pointing at an archived account doesn't show up as a row
  // with no name) and joined to the full account row for the name +
  // city + routable check.
  const planStops = useMemo(() => {
    if (!todayPlan?.stops) return [];
    const { stops } = pruneStopsAgainstAccounts(todayPlan.stops, accounts);
    return hydrateStops(stops, accounts);
  }, [todayPlan, accounts]);

  const planRouteUrl = useMemo(() => {
    const routable = planStops.map((h) => h.account).filter(hasRoutableAddress);
    return routable.length >= 2 ? buildAppleMapsRouteUrl(routable) : null;
  }, [planStops]);

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
  // Pass the rep's starred set so her shortlist bubbles to the top of
  // the local Top-5 fallback. The briefing-returned suggested_visits
  // (when present) are not re-ranked here — the edge function would
  // need its own starred-account awareness, tracked as a follow-up.
  const top = useMemo(
    () => rankAccounts(territoryAccounts, Date.now(), { starredIds }).slice(0, 5),
    [territoryAccounts, starredIds],
  );

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
  // Fall back to the *effective* rep's name (the audited rep when an
  // owner is viewing-as), not the signed-in owner's, so the greeting
  // matches the scoped briefing below it.
  const greetingName = briefingIdentity.name && briefingIdentity.name !== 'there'
    ? briefingIdentity.name
    : displayName;
  const greeting = briefing?.greeting
    ?? `${timeOfDayGreeting()}${greetingName ? `, ${greetingName}` : ''}`;
  const narrative = briefing?.narrative;
  const stats = briefing?.stats;
  const weekStats = stats?.week ?? week;

  // Briefing-returned suggestions are now scoped to the rep's territory
  // server-side (bd-briefing looks up the effective rep's territory cities
  // via the bd_territory_cities_for_user RPC). We keep this client-side
  // intersection as defense-in-depth so the rep's Top 5 (and the multi-
  // stop route built from it) stays scoped to South OC ∪ strategic even
  // if the server scope and the client's territory list ever drift.
  // No-ops when the rep has no territory configured.
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
    refreshPlan();
  }

  // Mode toggle. Null = auto-default ("plan" if she has saved stops,
  // otherwise "top5"). Once the rep manually toggles, their pick
  // sticks for the rest of the session — refreshing or saving the
  // plan doesn't override their explicit choice.
  const [userMode, setUserMode] = useState(null);
  const mode = userMode ?? (planStops.length > 0 ? 'plan' : 'top5');
  const planRoutableCount = useMemo(
    () => planStops.filter((p) => hasRoutableAddress(p.account)).length,
    [planStops],
  );

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
        <button
          type="button"
          className={s.linkBtn}
          onClick={() => navigate('/bd/mileage')}
        >
          <Gauge size={14} strokeWidth={1.75} aria-hidden /> Mileage
        </button>
      </div>

      <div className={s.card}>
        {/* Mode toggle — plan if she has one saved, top-5 otherwise,
            or the week recap for a Mon–Sun retrospective. Once the rep
            manually switches, their pick wins for the rest of the
            session. Same segmented-pill pattern as the territory
            toggle on the Accounts list so the design language stays
            consistent. */}
        <div className={s.territoryToggleRow}>
          <button
            type="button"
            className={`${s.territoryToggle} ${mode === 'plan' ? s.territoryToggleActive : ''}`}
            onClick={() => setUserMode('plan')}
            aria-pressed={mode === 'plan'}
          >
            Today&rsquo;s plan{planStops.length > 0 ? ` (${planStops.length})` : ''}
          </button>
          <button
            type="button"
            className={`${s.territoryToggle} ${mode === 'top5' ? s.territoryToggleActive : ''}`}
            onClick={() => setUserMode('top5')}
            aria-pressed={mode === 'top5'}
          >
            Top 5
          </button>
          <button
            type="button"
            className={`${s.territoryToggle} ${mode === 'week' ? s.territoryToggleActive : ''}`}
            onClick={() => setUserMode('week')}
            aria-pressed={mode === 'week'}
          >
            This week
          </button>
        </div>

        {mode !== 'week' && <div className={s.routeHeader}>
          {/* Section title slot stays empty — the toggle is the title.
              Right-side action pill changes per mode. */}
          <div />
          {mode === 'plan' ? (
            <div className={s.planActionGroup}>
              {/* Building/editing a plan is a write — hidden while an
                  owner is auditing a rep. The saved plan still renders
                  read-only below; "Open in Maps" stays available. */}
              {!isReadOnly && (
                <button
                  type="button"
                  className={s.routeBtn}
                  onClick={() => navigate('/bd/plan')}
                >
                  <ListOrdered size={14} aria-hidden />
                  <span>{planStops.length > 0 ? 'Edit' : 'Build'}</span>
                </button>
              )}
              {planRouteUrl && (
                <a
                  className={s.routeBtn}
                  href={planRouteUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Map size={14} aria-hidden />
                  <span>Open in Maps ({planRoutableCount})</span>
                </a>
              )}
            </div>
          ) : (
            routeUrl && (
              <a
                className={s.routeBtn}
                href={routeUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Map size={14} aria-hidden />
                <span>Plan route ({routeStops.length})</span>
              </a>
            )
          )}
        </div>}

        {mode === 'week' ? (
          <WeekRecap />
        ) : mode === 'plan' ? (
          planStops.length === 0 ? (
            <div className={s.planCardEmpty}>
              {isReadOnly
                ? 'No plan for today.'
                : <>No plan yet — tap <strong>Build</strong> to pick your stops for today.</>}
            </div>
          ) : (
            <div className={s.accountList}>
              {planStops.map(({ account }, i) => {
                const days  = daysSince(account.last_activity_at);
                const cold  = isCold(account);
                const count = account.activity_count ?? null;
                return (
                  <button
                    key={account.id}
                    type="button"
                    className={`${s.accountCard} ${cold ? s.accountCardCold : ''}`}
                    onClick={() => navigate(`/bd/accounts/${account.id}`)}
                  >
                    <span className={s.stopIndexBadge} aria-hidden>{i + 1}</span>
                    <div className={s.stopCardBody}>
                      <div className={s.accountName}>
                        {account.name}
                        {cold && <span className={`${s.tag} ${s.tagCold}`}>cold</span>}
                        {account.is_strategic_shared && <span className={s.tag}>strategic</span>}
                      </div>
                      <div className={s.accountMeta}>
                        {account.city ?? '—'}{count !== null ? ` · ${count} activities` : ''}
                      </div>
                    </div>
                    <div className={s.lastSeen}>{formatDays(days)}</div>
                  </button>
                );
              })}
            </div>
          )
        ) : accountsLoading && !suggested.length ? (
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
