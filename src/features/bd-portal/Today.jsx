import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBdAccounts } from './hooks/useBdAccounts';
import { useBdBriefing } from './hooks/useBdBriefing';
import { rankAccounts, summarizeWeek, daysSince } from './lib/bdQueries';
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
  const { loading: accountsLoading, accounts, activities, error: accountsError, refresh: refreshAccounts } = useBdAccounts();
  const { loading: briefingLoading, briefing, refresh: refreshBriefing } = useBdBriefing(displayName);

  const week = useMemo(() => summarizeWeek(activities), [activities]);
  const top = useMemo(() => rankAccounts(accounts).slice(0, 5), [accounts]);

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
  const suggested = briefing?.suggested_visits ?? top;
  const weekStats = stats?.week ?? week;

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
            You have {accounts.length} accounts in your territory.
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
        <div className={s.sectionTitle}>Top 5 to visit next</div>
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
