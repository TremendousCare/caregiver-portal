import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBdAccounts } from './hooks/useBdAccounts';
import { rankAccounts, summarizeWeek, daysSince } from './lib/bdQueries';
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
  const { loading, accounts, activities, error, refresh } = useBdAccounts();

  const week = useMemo(() => summarizeWeek(activities), [activities]);
  const top = useMemo(() => rankAccounts(accounts).slice(0, 5), [accounts]);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <p className={s.greeting}>{timeOfDayGreeting()}{displayName ? `, ${displayName}` : ''}</p>
          <h1 className={s.pageTitle}>Today</h1>
        </div>
        <button type="button" className={s.signOutBtn} onClick={refresh}>Refresh</button>
      </div>

      {error && <div className={s.error}>Couldn&rsquo;t load accounts: {error.message}</div>}

      <div className={s.card}>
        <div className={s.sectionTitle}>Briefing</div>
        {loading ? (
          <p className={s.briefingText}>Loading your accounts…</p>
        ) : (
          <p className={s.briefingText}>
            {accounts.length === 0
              ? 'No accounts yet. Run the Trello import to get started.'
              : `You have ${accounts.length} accounts in your territory. AI route briefing arrives in a follow-up release.`}
          </p>
        )}
      </div>

      <div className={s.card}>
        <div className={s.sectionTitle}>This week</div>
        <div className={s.counters}>
          <div className={s.counter}>
            <div className={s.counterValue}>{week.visits}</div>
            <div className={s.counterLabel}>visits</div>
          </div>
          <div className={s.counter}>
            <div className={s.counterValue}>{week.calls}</div>
            <div className={s.counterLabel}>calls</div>
          </div>
          <div className={s.counter}>
            <div className={s.counterValue}>{week.dropOffs}</div>
            <div className={s.counterLabel}>drop-offs</div>
          </div>
        </div>
      </div>

      <div className={s.card}>
        <div className={s.sectionTitle}>Top 5 to visit next</div>
        {loading ? (
          <p className={s.muted}>Loading…</p>
        ) : top.length === 0 ? (
          <p className={s.empty}>No accounts yet.</p>
        ) : (
          <div className={s.accountList}>
            {top.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`${s.accountCard} ${a._cold ? s.accountCardCold : ''}`}
                onClick={() => navigate(`/bd/accounts/${a.id}`)}
              >
                <div>
                  <div className={s.accountName}>
                    {a.name}
                    {a._cold && <span className={`${s.tag} ${s.tagCold}`}>cold</span>}
                  </div>
                  <div className={s.accountMeta}>
                    {a.city ?? '—'} · {a.activity_count} activities
                  </div>
                </div>
                <div className={s.lastSeen}>{formatDays(daysSince(a.last_activity_at))}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
