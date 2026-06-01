import {
  ResponsiveContainer,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
} from 'recharts';
import { formatMoney, formatMoneyCents, formatHours } from './format';
import s from './FinancialsTab.module.css';

const TOP_N = 10;

/**
 * Two horizontal bar charts for the selected period:
 *   1. Revenue by client (top 10).
 *   2. Hours by caregiver (top 10).
 *
 * @param {Array<{ clientId, name, revenue }>} byClient
 * @param {Array<{ caregiverId, name, totalHours }>} byCaregiver
 */
export function BreakdownCharts({ byClient, byCaregiver }) {
  const clientData = (byClient ?? []).slice(0, TOP_N).map((r) => ({ name: r.name, revenue: r.revenue }));
  const caregiverData = (byCaregiver ?? []).slice(0, TOP_N).map((r) => ({ name: r.name, hours: r.totalHours }));

  return (
    <div className={s.chartGrid}>
      <div className={s.chartCard}>
        <h3 className={s.chartTitle}>Revenue by Client</h3>
        <p className={s.chartSubtitle}>Top {TOP_N} for the selected period.</p>
        <div className={s.chartBodyTall}>
          {clientData.length === 0 ? (
            <div className={s.chartEmpty}>No revenue in this period.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={clientData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => formatMoney(v)} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
                <Tooltip formatter={(value) => [formatMoneyCents(value), 'Revenue']} />
                <Bar dataKey="revenue" fill="#29BEE4" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className={s.chartCard}>
        <h3 className={s.chartTitle}>Hours by Caregiver</h3>
        <p className={s.chartSubtitle}>Top {TOP_N} for the selected period.</p>
        <div className={s.chartBodyTall}>
          {caregiverData.length === 0 ? (
            <div className={s.chartEmpty}>No hours in this period.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={caregiverData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
                <Tooltip formatter={(value) => [formatHours(value), 'Hours']} />
                <Bar dataKey="hours" fill="#2E4E8D" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
