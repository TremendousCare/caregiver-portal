import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, DollarSign } from 'lucide-react';
import { useApp } from '../../../shared/context/AppContext';
import { isOwnerRole } from '../../../lib/auth/roles';
import {
  PERIOD_OPTIONS,
  DEFAULT_PERIOD,
  resolvePeriod,
} from '../../../lib/financials/financialsPeriods';
import {
  aggregateFinancials,
  computeMonthlyTrend,
  padMonthlySeries,
  buildKpi,
} from '../../../lib/financials/financialsMetrics';
import {
  fetchCompletedShifts,
  fetchRateConfig,
  fetchActiveCounts,
} from './storage';
import { KpiCards } from './KpiCards';
import { TrendCharts } from './TrendCharts';
import { BreakdownCharts } from './BreakdownCharts';
import { ClientProfitabilityTable } from './ClientProfitabilityTable';
import { formatMoney, formatPercent, formatHours, formatCount, formatMonthLabel } from './format';
import s from './FinancialsTab.module.css';

const TREND_MONTHS = 12;

/** Inclusive date filter on the YYYY-MM-DD portion of an ISO timestamp. */
function inRange(isoTs, start, end) {
  const d = (isoTs ?? '').slice(0, 10);
  return d >= start && d <= end;
}

/**
 * Owner-only Financials sub-tab. Rendered inside AccountingPage, which is
 * already AdminOnly + feature-gated; the owner check here is the access
 * boundary that keeps payroll/margin numbers away from admins & members.
 *
 * NOTE (access model — confirmed with owner): gating is UI-only for v1.
 * The underlying payroll/shift tables are RLS-gated to admins, not owners,
 * so an admin could still read raw rows via a direct query. If a hard
 * security boundary is needed later, move the aggregates behind an
 * owner-gated RPC / edge function.
 */
export function FinancialsTab() {
  const { currentOrgId, currentOrgRole } = useApp();
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  // Resolve the selected period + its prior comparison window once per
  // render. `now` is read at mount via resolvePeriod's default.
  const ranges = useMemo(() => resolvePeriod(period), [period]);
  const trailing12 = useMemo(() => resolvePeriod('t12m'), []);

  const owner = isOwnerRole(currentOrgRole);

  useEffect(() => {
    if (!owner) return undefined;
    let cancelled = false;

    async function load() {
      if (!currentOrgId) {
        setData(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        // Widest window we need: the earliest of the prior-period start
        // and the trailing-12 start, through today. One shifts query then
        // feeds the KPI tiles (current + prior), the breakdowns/table
        // (current), and the 12-month trend.
        const earliestStart = [ranges.prior.start, trailing12.current.start]
          .sort((a, b) => a.localeCompare(b))[0];
        const latestEnd = ranges.current.end;

        const [shifts, counts] = await Promise.all([
          fetchCompletedShifts({ orgId: currentOrgId, start: earliestStart, end: latestEnd }),
          fetchActiveCounts({ orgId: currentOrgId }),
        ]);

        const { clientsById, caregiversById } = await fetchRateConfig({
          orgId: currentOrgId,
          clientIds: shifts.map((sh) => sh.clientId),
          caregiverIds: shifts.map((sh) => sh.caregiverId),
        });

        if (cancelled) return;
        setData({ shifts, counts, clientsById, caregiversById });
      } catch (err) {
        if (!cancelled) setError(err?.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [owner, currentOrgId, ranges, trailing12]);

  // ─── Derived view model (pure) ────────────────────────────────
  const view = useMemo(() => {
    if (!data) return null;
    const { shifts, counts, clientsById, caregiversById } = data;

    const currentShifts = shifts.filter((sh) => inRange(sh.startTime, ranges.current.start, ranges.current.end));
    const priorShifts = shifts.filter((sh) => inRange(sh.startTime, ranges.prior.start, ranges.prior.end));

    const current = aggregateFinancials({ shifts: currentShifts, clientsById, caregiversById });
    const prior = aggregateFinancials({ shifts: priorShifts, clientsById, caregiversById });

    const trendRaw = computeMonthlyTrend({
      shifts: shifts.filter((sh) => inRange(sh.startTime, trailing12.current.start, trailing12.current.end)),
      clientsById,
      caregiversById,
    });
    const trend = padMonthlySeries(trendRaw, trailing12.current.end.slice(0, 7), TREND_MONTHS);

    return { current, prior, trend, counts };
  }, [data, ranges, trailing12]);

  // ─── Access guard ─────────────────────────────────────────────
  if (!owner) {
    return (
      <div className={s.notice}>
        The Financials view is restricted to organization owners.
      </div>
    );
  }

  if (loading) {
    return <div className={s.notice}>Loading financials…</div>;
  }

  if (error) {
    return <div className={s.noticeError}>Couldn’t load financials: {error}</div>;
  }

  if (!view) {
    return <div className={s.notice}>No financial data available.</div>;
  }

  const { current, prior, trend, counts } = view;
  const t = current.totals;
  const p = prior.totals;

  const kpiCards = [
    {
      key: 'revenue',
      label: 'Revenue',
      value: formatMoney(t.revenue),
      pctDelta: buildKpi(t.revenue, p.revenue).pctDelta,
      hint: 'Billed (est.)',
    },
    {
      key: 'laborCost',
      label: 'Labor Cost',
      value: formatMoney(t.laborCost),
      pctDelta: buildKpi(t.laborCost, p.laborCost).pctDelta,
      goodWhenUp: false,
      hint: 'Caregiver pay',
    },
    {
      key: 'grossMargin',
      label: 'Gross Margin',
      value: formatMoney(t.grossMargin),
      pctDelta: buildKpi(t.grossMargin, p.grossMargin).pctDelta,
      hint: 'Revenue − labor',
    },
    {
      key: 'grossMarginPct',
      label: 'Gross Margin %',
      value: formatPercent(t.grossMarginPct),
      pctDelta: buildKpi(t.grossMarginPct ?? 0, p.grossMarginPct ?? 0).pctDelta,
      hint: 'The spread',
    },
    {
      key: 'hours',
      label: 'Billable Hours',
      value: formatHours(t.totalHours),
      pctDelta: buildKpi(t.totalHours, p.totalHours).pctDelta,
      hint: `${formatHours(t.overtimeHours + t.doubleTimeHours)} OT/DT`,
    },
    {
      key: 'overtimePct',
      label: 'Overtime %',
      value: formatPercent(t.overtimePct),
      pctDelta: buildKpi(t.overtimePct ?? 0, p.overtimePct ?? 0).pctDelta,
      goodWhenUp: false,
      hint: 'Of total hours',
    },
    {
      key: 'activeClients',
      label: 'Active Clients',
      value: formatCount(counts.activeClients),
      pctDelta: null,
      hint: 'Currently',
    },
    {
      key: 'activeCaregivers',
      label: 'Active Caregivers',
      value: formatCount(counts.activeCaregivers),
      pctDelta: null,
      hint: 'Currently',
    },
  ];

  const excluded = current.excluded;
  const hasExclusions = excluded.missingRevenueRate > 0 || excluded.missingCostRate > 0;

  return (
    <div className={s.tab}>
      <div className={s.toolbar}>
        <div className={s.toolbarLeft}>
          <DollarSign size={18} className={s.toolbarIcon} />
          <span className={s.toolbarTitle}>Financials</span>
          <span className={s.toolbarRange}>
            {ranges.current.start} → {ranges.current.end}
          </span>
        </div>
        <div className={s.periodSelect} role="tablist" aria-label="Period">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={period === opt.id}
              className={`${s.periodBtn} ${period === opt.id ? s.periodBtnActive : ''}`}
              onClick={() => setPeriod(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <p className={s.estimateNote}>
        Figures are an analytics estimate computed from completed shifts and
        configured rates. Authoritative billing and payroll live on the
        Invoicing and Payroll tabs.
      </p>

      {hasExclusions ? (
        <div className={s.warnBanner}>
          <AlertTriangle size={15} />
          <span>
            {excluded.missingRevenueRate > 0 && (
              <>{excluded.missingRevenueRate} shift{excluded.missingRevenueRate === 1 ? '' : 's'} excluded from revenue (no billable rate). </>
            )}
            {excluded.missingCostRate > 0 && (
              <>{excluded.missingCostRate} shift{excluded.missingCostRate === 1 ? '' : 's'} excluded from labor cost (no pay rate). </>
            )}
            Set rates on the client/caregiver or shift to include them.
          </span>
        </div>
      ) : null}

      <KpiCards cards={kpiCards} />

      <TrendCharts series={trend} />

      <BreakdownCharts byClient={current.byClient} byCaregiver={current.byCaregiver} />

      <section className={s.section}>
        <h3 className={s.sectionTitle}>Client Profitability</h3>
        <p className={s.sectionSubtitle}>
          {formatMonthLabel(ranges.current.start.slice(0, 7))} period · sortable
        </p>
        <ClientProfitabilityTable rows={current.byClient} />
      </section>
    </div>
  );
}
