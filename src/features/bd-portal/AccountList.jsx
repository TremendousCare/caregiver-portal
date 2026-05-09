import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBdAccounts } from './hooks/useBdAccounts';
import { rankAccounts, searchAccounts, daysSince } from './lib/bdQueries';
import s from './BdPortal.module.css';

function formatDays(d) {
  if (d === null || d === undefined) return 'never';
  if (d === 0) return 'today';
  if (d === 1) return '1d';
  return `${d}d`;
}

export function AccountList() {
  const navigate = useNavigate();
  const { loading, accounts, error, refresh } = useBdAccounts();
  const [term, setTerm] = useState('');

  const visible = useMemo(() => {
    const ranked = rankAccounts(accounts);
    return searchAccounts(ranked, term);
  }, [accounts, term]);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <p className={s.greeting}>{accounts.length} accounts</p>
          <h1 className={s.pageTitle}>Accounts</h1>
        </div>
        <button type="button" className={s.signOutBtn} onClick={refresh}>Refresh</button>
      </div>

      {error && <div className={s.error}>Couldn&rsquo;t load accounts: {error.message}</div>}

      <div className={s.searchRow}>
        <input
          className={s.searchInput}
          type="search"
          placeholder="Search by name or city"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>

      {loading ? (
        <div className={s.empty}>Loading…</div>
      ) : visible.length === 0 ? (
        <div className={s.empty}>
          {term ? `No accounts match “${term}”.` : 'No accounts yet.'}
        </div>
      ) : (
        <div className={s.accountList}>
          {visible.map((a) => (
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
                  {a.account_type === 'professional' ? 'Professional' : (a.facility_subtype ?? 'Facility')}
                  {a.city ? ` · ${a.city}` : ''}
                  {' · '}{a.activity_count} activities
                </div>
              </div>
              <div className={s.lastSeen}>{formatDays(daysSince(a.last_activity_at))}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
