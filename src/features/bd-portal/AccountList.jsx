import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBdAccounts } from './hooks/useBdAccounts';
import { rankAccounts, searchAccounts, daysSince, filterToTerritory } from './lib/bdQueries';
import s from './BdPortal.module.css';

function formatDays(d) {
  if (d === null || d === undefined) return 'never';
  if (d === 0) return 'today';
  if (d === 1) return '1d';
  return `${d}d`;
}

export function AccountList() {
  const navigate = useNavigate();
  const { loading, accounts, territoryCities, error, refresh } = useBdAccounts();
  const [term, setTerm] = useState('');
  // Default to "your territory" view; rep can opt into the org-wide
  // list to find an out-of-territory account (e.g. when a referral
  // arrives from a hospital outside South OC). Searching while in the
  // territory view still searches only the territory slice — if the
  // search returns nothing, the empty-state nudges them to toggle.
  const [showAll, setShowAll] = useState(false);

  const territoryAccounts = useMemo(
    () => filterToTerritory(accounts, territoryCities),
    [accounts, territoryCities],
  );
  const hasTerritoryFilter = territoryCities.length > 0;
  const scoped = (showAll || !hasTerritoryFilter) ? accounts : territoryAccounts;

  const visible = useMemo(() => {
    const ranked = rankAccounts(scoped);
    return searchAccounts(ranked, term);
  }, [scoped, term]);

  const headerCount = scoped.length;
  const hiddenByFilter = hasTerritoryFilter && !showAll
    ? Math.max(accounts.length - territoryAccounts.length, 0)
    : 0;

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <p className={s.greeting}>{headerCount} accounts{hasTerritoryFilter && !showAll ? ' in your territory' : ''}</p>
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

      {hasTerritoryFilter && (
        <div className={s.territoryToggleRow}>
          <button
            type="button"
            className={`${s.territoryToggle} ${!showAll ? s.territoryToggleActive : ''}`}
            onClick={() => setShowAll(false)}
            aria-pressed={!showAll}
          >
            Your territory
          </button>
          <button
            type="button"
            className={`${s.territoryToggle} ${showAll ? s.territoryToggleActive : ''}`}
            onClick={() => setShowAll(true)}
            aria-pressed={showAll}
          >
            All accounts{hiddenByFilter ? ` (+${hiddenByFilter})` : ''}
          </button>
        </div>
      )}

      {loading ? (
        <div className={s.empty}>Loading…</div>
      ) : visible.length === 0 ? (
        <div className={s.empty}>
          {term
            ? `No accounts match “${term}”${hasTerritoryFilter && !showAll ? ' in your territory' : ''}.`
            : 'No accounts yet.'}
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
                  {a.is_strategic_shared && <span className={s.tag}>strategic</span>}
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
