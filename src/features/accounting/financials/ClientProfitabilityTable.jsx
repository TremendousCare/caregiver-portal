import { useMemo, useState } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { formatMoneyCents, formatHours, formatPercent } from './format';
import s from './FinancialsTab.module.css';

const COLUMNS = [
  { key: 'name', label: 'Client', align: 'left', numeric: false },
  { key: 'totalHours', label: 'Hours', align: 'right', numeric: true, fmt: formatHours },
  { key: 'revenue', label: 'Revenue', align: 'right', numeric: true, fmt: formatMoneyCents },
  { key: 'laborCost', label: 'Labor Cost', align: 'right', numeric: true, fmt: formatMoneyCents },
  { key: 'grossMargin', label: 'Margin', align: 'right', numeric: true, fmt: formatMoneyCents },
  { key: 'grossMarginPct', label: 'Margin %', align: 'right', numeric: true, fmt: formatPercent },
];

/**
 * Sortable per-client profitability table for the selected period.
 * @param {Array<{ clientId, name, totalHours, revenue, laborCost, grossMargin, grossMarginPct }>} rows
 */
export function ClientProfitabilityTable({ rows }) {
  const [sortKey, setSortKey] = useState('revenue');
  const [sortDir, setSortDir] = useState('desc');

  const sorted = useMemo(() => {
    const copy = [...(rows ?? [])];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' || typeof bv === 'string') {
        const cmp = String(av ?? '').localeCompare(String(bv ?? ''));
        return sortDir === 'asc' ? cmp : -cmp;
      }
      // nulls (e.g. margin% with no revenue) sort last regardless of dir
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  }

  if ((rows ?? []).length === 0) {
    return <div className={s.tableEmpty}>No client activity in this period.</div>;
  }

  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className={col.align === 'right' ? s.thRight : s.thLeft}
                onClick={() => toggleSort(col.key)}
                aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <span className={s.thInner}>
                  {col.label}
                  {sortKey === col.key
                    ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
                    : null}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.clientId}>
              {COLUMNS.map((col) => (
                <td key={col.key} className={col.align === 'right' ? s.tdRight : s.tdLeft}>
                  {col.fmt ? col.fmt(row[col.key]) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
