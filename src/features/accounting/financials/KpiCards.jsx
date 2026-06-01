import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import s from './FinancialsTab.module.css';

/**
 * Grid of KPI tiles. Each card shows a headline value and, when a prior
 * baseline exists, a period-over-period delta with directional color.
 *
 * @param {Array<{
 *   key: string,
 *   label: string,
 *   value: string,        // pre-formatted display string
 *   pctDelta: number|null,// percentage change vs prior period
 *   goodWhenUp?: boolean, // whether an increase is positive (default true)
 *   hint?: string,        // small caption under the value
 * }>} cards
 */
export function KpiCards({ cards }) {
  return (
    <div className={s.kpiGrid}>
      {cards.map((c) => (
        <div key={c.key} className={s.kpiCard}>
          <span className={s.kpiLabel}>{c.label}</span>
          <span className={s.kpiValue}>{c.value}</span>
          <div className={s.kpiFooter}>
            <Delta pctDelta={c.pctDelta} goodWhenUp={c.goodWhenUp !== false} />
            {c.hint ? <span className={s.kpiHint}>{c.hint}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function Delta({ pctDelta, goodWhenUp }) {
  if (pctDelta == null) {
    return <span className={s.deltaNeutral}>No prior data</span>;
  }
  if (pctDelta === 0) {
    return (
      <span className={s.deltaNeutral}>
        <Minus size={13} /> 0.0%
      </span>
    );
  }
  const up = pctDelta > 0;
  const positive = up === goodWhenUp;
  const cls = positive ? s.deltaUp : s.deltaDown;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={cls}>
      <Icon size={13} />
      {`${up ? '+' : ''}${pctDelta.toFixed(1)}%`}
    </span>
  );
}
