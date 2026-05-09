import { useNavigate } from 'react-router-dom';
import { useBdFunnel } from './hooks/useBdFunnel';
import { PERIODS, PERIOD_LABELS } from './lib/funnelQueries';
import s from './FunnelReport.module.css';

function pct(x) {
  if (!x || !Number.isFinite(x)) return '0%';
  return `${Math.round(x * 100)}%`;
}

function dollars(cents) {
  if (!cents) return '$0';
  return `$${(cents / 100).toFixed(0)}`;
}

function daysLabel(d) {
  if (d === null || d === undefined) return 'never visited';
  if (d === 0) return 'today';
  return `${d}d ago`;
}

export function FunnelReport() {
  const navigate = useNavigate();
  const {
    loading, error, period, setPeriod, refresh,
    funnel, ranked, lostReasons, cold,
  } = useBdFunnel('month');

  const topAccounts = ranked.filter((a) => a.visits + a.referrals + a.socs > 0).slice(0, 12);
  const goToAccount = (id) => navigate(`/bd/accounts/${id}`);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Business Development — Funnel</h1>
          <p className={s.subtitle}>{PERIOD_LABELS[period]}{loading ? ' · loading…' : ''}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className={s.periodTabs} role="tablist">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={period === p}
                className={`${s.periodTab} ${period === p ? s.active : ''}`}
                onClick={() => setPeriod(p)}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
          <button type="button" className={s.refreshBtn} onClick={refresh}>Refresh</button>
        </div>
      </div>

      {error && <div className={s.error}>Couldn&rsquo;t load funnel: {error.message}</div>}

      {/* Top-level funnel */}
      <div className={s.funnelRow}>
        <div className={s.metricCard}>
          <div className={s.metricLabel}>Visits</div>
          <div className={s.metricValue}>{funnel.visits}</div>
          <div className={s.metricSub}>logged in {PERIOD_LABELS[period].toLowerCase()}</div>
        </div>
        <div className={s.metricCard}>
          <div className={s.metricLabel}>Referrals</div>
          <div className={s.metricValue}>{funnel.referrals}</div>
          <div className={s.metricSub}>
            <strong>{pct(funnel.visit_to_referral)}</strong> visit→referral
          </div>
        </div>
        <div className={s.metricCard}>
          <div className={s.metricLabel}>Starts of Care</div>
          <div className={s.metricValue}>{funnel.socs}</div>
          <div className={s.metricSub}>
            <strong>{pct(funnel.referral_to_soc)}</strong> referral→SOC
          </div>
        </div>
        <div className={s.metricCard}>
          <div className={s.metricLabel}>Lost</div>
          <div className={s.metricValue}>{funnel.lost}</div>
          <div className={s.metricSub}>referrals that did not convert</div>
        </div>
      </div>

      <div className={s.row2}>
        {/* Top accounts table */}
        <div className={s.card}>
          <h2 className={s.cardTitle}>Top accounts</h2>
          <p className={s.cardSub}>By starts of care, then referrals, then visits in {PERIOD_LABELS[period].toLowerCase()}.</p>
          {loading ? (
            <div className={s.empty}>Loading…</div>
          ) : topAccounts.length === 0 ? (
            <div className={s.empty}>No activity yet in this period.</div>
          ) : (
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th className={s.numCell}>Visits</th>
                  <th className={s.numCell}>Calls</th>
                  <th className={s.numCell}>Drops</th>
                  <th className={s.numCell}>Refs</th>
                  <th className={s.numCell}>SOCs</th>
                  <th className={s.numCell}>Conv.</th>
                  <th className={s.numCell}>Spend</th>
                </tr>
              </thead>
              <tbody>
                {topAccounts.map((a) => (
                  <tr key={a.account_id} onClick={() => goToAccount(a.account_id)}>
                    <td>
                      {a.name}
                      {a._cold && <span className={`${s.tag} ${s.tagCold}`}>cold</span>}
                      <div style={{ fontSize: 11, color: '#5A6B85' }}>
                        {a.account_type === 'professional' ? 'Professional' : (a.facility_subtype ?? 'Facility')}
                        {a.city ? ` · ${a.city}` : ''}
                      </div>
                    </td>
                    <td className={s.numCell}>{a.visits}</td>
                    <td className={s.numCell}>{a.calls}</td>
                    <td className={s.numCell}>{a.drop_offs}</td>
                    <td className={s.numCell}>{a.referrals}</td>
                    <td className={s.numCell}>{a.socs}</td>
                    <td className={s.numCell}>{pct(a.conversion)}</td>
                    <td className={s.numCell}>{dollars(a.spend_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Lost-reason breakdown */}
        <div className={s.card}>
          <h2 className={s.cardTitle}>Lost referrals — why?</h2>
          <p className={s.cardSub}>Reasons referrals didn&rsquo;t convert in {PERIOD_LABELS[period].toLowerCase()}.</p>
          {loading ? (
            <div className={s.empty}>Loading…</div>
          ) : lostReasons.length === 0 ? (
            <div className={s.empty}>No lost referrals yet.</div>
          ) : (
            <div className={s.lossBar}>
              {lostReasons.map((row) => (
                <div key={row.reason}>
                  <div className={s.lossRow}>
                    <div className={s.lossLabel}>{row.label}</div>
                    <div className={s.lossCount}>{row.count} · {pct(row.pct)}</div>
                  </div>
                  <div className={s.lossBarTrack}>
                    <div className={s.lossBarFill} style={{ width: `${Math.max(8, row.pct * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Cold accounts */}
      <div className={s.card}>
        <h2 className={s.cardTitle}>Cold accounts</h2>
        <p className={s.cardSub}>No activity in 21+ days. Use this list to plan the next route.</p>
        {loading ? (
          <div className={s.empty}>Loading…</div>
        ) : cold.length === 0 ? (
          <div className={s.empty}>None — every account has recent activity.</div>
        ) : (
          <div className={s.coldList}>
            {cold.slice(0, 24).map((a) => (
              <div key={a.id} className={s.coldRow} onClick={() => goToAccount(a.id)}>
                <div className={s.coldName}>{a.name}</div>
                <div className={s.coldDays}>{daysLabel(a._days)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
