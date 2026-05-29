import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Plus } from 'lucide-react';
import { useBdAccounts } from './hooks/useBdAccounts';
import { useBdAccountStars } from './hooks/useBdAccountStars';
import { useBdViewAs } from './context/BdViewAsContext';
import { rankAccounts, searchAccounts, daysSince, filterToTerritory } from './lib/bdQueries';
import s from './BdPortal.module.css';

function formatDays(d) {
  if (d === null || d === undefined) return 'never';
  if (d === 0) return 'today';
  if (d === 1) return '1d';
  return `${d}d`;
}

// Three-way scope toggle for the Accounts list:
//   - my:        accounts the rep has personally starred
//   - territory: rep's territory ∪ strategic-shared (the default)
//   - all:       org-wide
const SCOPE_TERRITORY = 'territory';
const SCOPE_MY        = 'my';
const SCOPE_ALL       = 'all';

export function AccountList() {
  const navigate = useNavigate();
  const { loading, accounts, territoryCities, error, refresh } = useBdAccounts();
  const { starredIds, isStarred, toggle: toggleStar, error: starsError } = useBdAccountStars();
  const { isReadOnly } = useBdViewAs();
  const [term, setTerm] = useState('');
  // Default to "your territory" view; rep can opt into "my accounts"
  // for their personal shortlist or "all accounts" to find an
  // out-of-territory account (e.g. a referral from a hospital outside
  // South OC). Searching while a scope is active still searches only
  // that slice — if the search returns nothing, the empty-state
  // suggests broadening the scope.
  const [scope, setScope] = useState(SCOPE_TERRITORY);

  const territoryAccounts = useMemo(
    () => filterToTerritory(accounts, territoryCities),
    [accounts, territoryCities],
  );
  const hasTerritoryFilter = territoryCities.length > 0;

  // The base slice the user is browsing (before search).
  const scoped = useMemo(() => {
    if (scope === SCOPE_MY) {
      return accounts.filter((a) => starredIds.has(a.id));
    }
    if (scope === SCOPE_ALL || !hasTerritoryFilter) {
      return accounts;
    }
    return territoryAccounts;
  }, [scope, accounts, starredIds, territoryAccounts, hasTerritoryFilter]);

  const visible = useMemo(() => {
    const ranked = rankAccounts(scoped, Date.now(), { starredIds });
    return searchAccounts(ranked, term);
  }, [scoped, starredIds, term]);

  const headerCount = scoped.length;
  const myCount = useMemo(
    () => accounts.filter((a) => starredIds.has(a.id)).length,
    [accounts, starredIds],
  );
  const hiddenByFilter = (scope === SCOPE_TERRITORY) && hasTerritoryFilter
    ? Math.max(accounts.length - territoryAccounts.length, 0)
    : 0;

  const headerLabel = scope === SCOPE_MY
    ? ` you've starred`
    : scope === SCOPE_TERRITORY && hasTerritoryFilter
      ? ' in your territory'
      : '';

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <p className={s.greeting}>{headerCount} accounts{headerLabel}</p>
          <h1 className={s.pageTitle}>Accounts</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Adding an account is a write — hidden while auditing a rep. */}
          {!isReadOnly && (
            <button
              type="button"
              className={s.signOutBtn}
              onClick={() => navigate('/bd/accounts/new')}
              aria-label="Add a new account"
            >
              <Plus size={14} aria-hidden style={{ verticalAlign: '-2px' }} /> Add
            </button>
          )}
          <button type="button" className={s.signOutBtn} onClick={refresh}>Refresh</button>
        </div>
      </div>

      {error && <div className={s.error}>Couldn&rsquo;t load accounts: {error.message}</div>}
      {starsError && <div className={s.error}>Couldn&rsquo;t update star: {starsError.message}</div>}

      <div className={s.searchRow}>
        <input
          className={s.searchInput}
          type="search"
          placeholder="Search by name or city"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>

      <div className={s.territoryToggleRow}>
        {hasTerritoryFilter && (
          <button
            type="button"
            className={`${s.territoryToggle} ${scope === SCOPE_TERRITORY ? s.territoryToggleActive : ''}`}
            onClick={() => setScope(SCOPE_TERRITORY)}
            aria-pressed={scope === SCOPE_TERRITORY}
          >
            Your territory
          </button>
        )}
        <button
          type="button"
          className={`${s.territoryToggle} ${scope === SCOPE_MY ? s.territoryToggleActive : ''}`}
          onClick={() => setScope(SCOPE_MY)}
          aria-pressed={scope === SCOPE_MY}
        >
          My accounts{myCount > 0 ? ` (${myCount})` : ''}
        </button>
        <button
          type="button"
          className={`${s.territoryToggle} ${scope === SCOPE_ALL ? s.territoryToggleActive : ''}`}
          onClick={() => setScope(SCOPE_ALL)}
          aria-pressed={scope === SCOPE_ALL}
        >
          All{hiddenByFilter ? ` (+${hiddenByFilter})` : ''}
        </button>
      </div>

      {loading ? (
        <div className={s.empty}>Loading…</div>
      ) : visible.length === 0 ? (
        <div className={s.empty}>
          {term
            ? `No accounts match “${term}”${headerLabel}.`
            : scope === SCOPE_MY
              ? "You haven't starred any accounts yet. Tap the star icon on any row to add it to your shortlist."
              : 'No accounts yet.'}
        </div>
      ) : (
        <div className={s.accountList}>
          {visible.map((a) => {
            const starred = isStarred(a.id);
            return (
              // The card is a flex row of two siblings — a star button
              // and a navigation button — rather than nesting a button
              // inside a button (invalid HTML; browsers split them).
              // The wrapping div carries the cold-card styling.
              <div
                key={a.id}
                className={`${s.accountCard} ${a._cold ? s.accountCardCold : ''}`}
              >
                <button
                  type="button"
                  className={`${s.starBtn} ${starred ? s.starBtnActive : ''}`}
                  onClick={() => toggleStar(a.id)}
                  disabled={isReadOnly}
                  aria-label={starred ? 'Remove from My accounts' : 'Add to My accounts'}
                  aria-pressed={starred}
                >
                  <Star
                    size={18}
                    strokeWidth={2}
                    fill={starred ? 'currentColor' : 'none'}
                    aria-hidden
                  />
                </button>
                <button
                  type="button"
                  className={s.accountCardBody}
                  onClick={() => navigate(`/bd/accounts/${a.id}`)}
                >
                  <div className={s.accountCardBodyText}>
                    <div className={s.accountName}>
                      {a.name}
                      {a._prospect && <span className={`${s.tag} ${s.tagProspect}`}>prospect</span>}
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
