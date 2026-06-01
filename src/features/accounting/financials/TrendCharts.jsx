import {
  ResponsiveContainer,
  ComposedChart,
  LineChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  Bar,
  Line,
} from 'recharts';
import { formatMoney, formatMoneyCents, formatPercent, formatMonthLabel } from './format';
import s from './FinancialsTab.module.css';

/**
 * Two trailing-12-month trend charts:
 *   1. Revenue vs Labor Cost (grouped bars) with gross margin overlaid.
 *   2. Gross margin % (line).
 *
 * @param {Array<{ month, revenue, laborCost, grossMargin, grossMarginPct }>} series
 *   Already padded to a continuous month axis.
 */
export function TrendCharts({ series }) {
  const data = (series ?? []).map((row) => ({
    ...row,
    label: formatMonthLabel(row.month),
  }));

  return (
    <div className={s.chartGrid}>
      <div className={s.chartCard}>
        <h3 className={s.chartTitle}>Revenue vs Labor Cost</h3>
        <p className={s.chartSubtitle}>Trailing 12 months. Line = gross margin.</p>
        <div className={s.chartBody}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatMoney(v)} width={70} />
              <Tooltip formatter={(value, name) => [formatMoneyCents(value), name]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="revenue" name="Revenue" fill="#29BEE4" />
              <Bar dataKey="laborCost" name="Labor Cost" fill="#2E4E8D" />
              <Line type="monotone" dataKey="grossMargin" name="Gross Margin" stroke="#16A34A" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className={s.chartCard}>
        <h3 className={s.chartTitle}>Gross Margin %</h3>
        <p className={s.chartSubtitle}>Trailing 12 months.</p>
        <div className={s.chartBody}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} width={48} />
              <Tooltip formatter={(value) => [formatPercent(value), 'Gross Margin']} />
              <Line type="monotone" dataKey="grossMarginPct" name="Gross Margin %" stroke="#16A34A" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
