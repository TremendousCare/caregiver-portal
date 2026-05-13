import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUp, ArrowDown, Plus, X, Map, Save } from 'lucide-react';
import { useBdAccounts } from './hooks/useBdAccounts';
import { useBdTodayPlan } from './hooks/useBdTodayPlan';
import {
  rankAccounts,
  searchAccounts,
  filterToTerritory,
  buildAppleMapsRouteUrl,
  hasRoutableAddress,
} from './lib/bdQueries';
import {
  addStopToPlan,
  removeStopFromPlan,
  moveStop,
  hydrateStops,
  pruneStopsAgainstAccounts,
} from './lib/bdRoutePlans';
import s from './BdPortal.module.css';

const MAX_STOPS = 12;

function formatPlanDateLabel(iso) {
  // Reps see the plan dated in their local TZ; render as "Tuesday,
  // May 13" so the date isn't ambiguous next to other timestamps.
  const [y, m, d] = (iso ?? '').split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return '';
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

export function RouteBuilder() {
  const navigate = useNavigate();
  const { accounts, territoryCities, loading: accountsLoading } = useBdAccounts();
  const { plan, planDate, loading: planLoading, save, error: planError } = useBdTodayPlan();

  const [draftStops, setDraftStops] = useState(null);
  const [pickerTerm, setPickerTerm] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Pruned active stops, with full account rows joined in route order.
  const liveStops = useMemo(() => {
    const source = draftStops ?? plan?.stops ?? [];
    const { stops } = pruneStopsAgainstAccounts(source, accounts);
    return stops;
  }, [draftStops, plan, accounts]);

  const hydrated = useMemo(() => hydrateStops(liveStops, accounts), [liveStops, accounts]);
  const stopIds  = useMemo(() => new Set(liveStops.map((s) => s.account_id)), [liveStops]);

  // Picker = territory accounts not already in the plan, ranked by
  // visit priority so the most useful candidates surface first.
  const pickerCandidates = useMemo(() => {
    const inTerritory = filterToTerritory(accounts, territoryCities);
    const remaining   = inTerritory.filter((a) => !stopIds.has(a.id));
    const ranked      = rankAccounts(remaining);
    return searchAccounts(ranked, pickerTerm).slice(0, 30);
  }, [accounts, territoryCities, stopIds, pickerTerm]);

  const routeUrl = useMemo(() => {
    const stops = hydrated.map((h) => h.account).filter(hasRoutableAddress);
    return stops.length >= 2 ? buildAppleMapsRouteUrl(stops) : null;
  }, [hydrated]);

  const isDirty   = draftStops !== null;
  const stopCount = liveStops.length;
  const canSave   = isDirty && !saving;

  function handleAdd(accountId) {
    if (stopCount >= MAX_STOPS) return;
    setDraftStops(addStopToPlan(liveStops, accountId));
  }

  function handleRemove(accountId) {
    setDraftStops(removeStopFromPlan(liveStops, accountId));
  }

  function handleMove(accountId, direction) {
    setDraftStops(moveStop(liveStops, accountId, direction));
  }

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    const { error: err } = await save(liveStops);
    setSaving(false);
    if (err) {
      setSaveError(err);
      return;
    }
    setDraftStops(null);
  }

  return (
    <div className={s.page}>
      <div className={s.detailHeader}>
        <button type="button" className={s.backBtn} onClick={() => navigate('/bd')}>← Today</button>
        <h1 className={s.pageTitle} style={{ margin: 0 }}>Route plan</h1>
      </div>

      <div className={s.card}>
        <div className={s.routeHeader}>
          <div>
            <div className={s.sectionTitle}>Plan for</div>
            <div className={s.accountName}>{formatPlanDateLabel(planDate)}</div>
            <div className={s.muted} style={{ fontSize: 12, marginTop: 2 }}>
              {stopCount} {stopCount === 1 ? 'stop' : 'stops'}{isDirty ? ' · unsaved' : ''}
            </div>
          </div>
          {routeUrl && (
            <a className={s.routeBtn} href={routeUrl} target="_blank" rel="noreferrer">
              <Map size={14} aria-hidden />
              <span>Open in Maps</span>
            </a>
          )}
        </div>

        {planError && (
          <div className={s.error} style={{ marginTop: 8 }}>
            Couldn&rsquo;t load plan: {planError.message}
          </div>
        )}
        {saveError && (
          <div className={s.error} style={{ marginTop: 8 }}>
            Save failed: {saveError.message}
          </div>
        )}

        {planLoading || accountsLoading ? (
          <p className={s.muted} style={{ marginTop: 12 }}>Loading…</p>
        ) : hydrated.length === 0 ? (
          <p className={s.empty} style={{ marginTop: 12 }}>
            No stops yet. Add accounts from the list below.
          </p>
        ) : (
          <ol className={s.routeStopList}>
            {hydrated.map(({ account }, i) => {
              const canMoveUp   = i > 0;
              const canMoveDown = i < hydrated.length - 1;
              const routable    = hasRoutableAddress(account);
              return (
                <li key={account.id} className={s.routeStop}>
                  <span className={s.routeStopIndex}>{i + 1}</span>
                  <div className={s.routeStopBody}>
                    <div className={s.accountName}>{account.name}</div>
                    <div className={s.accountMeta}>
                      {account.city ?? '—'}
                      {!routable && ' · no address yet'}
                    </div>
                  </div>
                  <div className={s.routeStopActions}>
                    <button
                      type="button"
                      className={s.routeStopBtn}
                      onClick={() => handleMove(account.id, -1)}
                      disabled={!canMoveUp}
                      aria-label="Move earlier"
                    >
                      <ArrowUp size={16} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={s.routeStopBtn}
                      onClick={() => handleMove(account.id, +1)}
                      disabled={!canMoveDown}
                      aria-label="Move later"
                    >
                      <ArrowDown size={16} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={s.routeStopBtnDanger}
                      onClick={() => handleRemove(account.id)}
                      aria-label="Remove stop"
                    >
                      <X size={16} aria-hidden />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        <button
          type="button"
          className={s.button}
          onClick={handleSave}
          disabled={!canSave}
          style={{ marginTop: 12 }}
        >
          <Save size={16} aria-hidden />
          <span>{saving ? 'Saving…' : isDirty ? 'Save plan' : 'Saved'}</span>
        </button>
      </div>

      <div className={s.card}>
        <div className={s.sectionTitle}>Add a stop</div>
        <input
          className={s.searchInput}
          type="search"
          placeholder="Search your territory"
          value={pickerTerm}
          onChange={(e) => setPickerTerm(e.target.value)}
        />
        {stopCount >= MAX_STOPS && (
          <p className={s.muted} style={{ marginTop: 8, fontSize: 12 }}>
            Plans are capped at {MAX_STOPS} stops. Remove one to add another.
          </p>
        )}
        <div className={s.accountList} style={{ marginTop: 8 }}>
          {pickerCandidates.length === 0 ? (
            <div className={s.empty}>
              {pickerTerm ? `No accounts match “${pickerTerm}”.` : 'Everything in your territory is already on the plan.'}
            </div>
          ) : (
            pickerCandidates.map((a) => (
              <button
                key={a.id}
                type="button"
                className={s.accountCard}
                onClick={() => handleAdd(a.id)}
                disabled={stopCount >= MAX_STOPS}
              >
                <div>
                  <div className={s.accountName}>{a.name}</div>
                  <div className={s.accountMeta}>
                    {a.city ?? '—'}
                    {' · '}{a.activity_count ?? 0} activities
                  </div>
                </div>
                <span className={s.routeStopBtn} aria-hidden>
                  <Plus size={16} />
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
