import { useState } from 'react';
import { ThisWeekView } from './ThisWeekView';
import s from './InvoicingTab.module.css';

const VIEWS = [
  { id: 'this_week', label: 'This Week' },
  // Phase 2 will add 'invoices' (per-client invoice history) and Phase 3
  // will add 'runs' (invoice run history) + 'settings' (per-client rate
  // config). The segmented control is here so future phases only add
  // onClick + state, not layout.
];

/**
 * Invoicing sub-tab — Phase 1 read-only preview.
 *
 * Shows a "This Week" rollup of every completed shift in the prior
 * workweek grouped by client, with the live computation of what the
 * billable total WOULD BE if we generated invoices today. No drafts
 * are persisted; that's Phase 2.
 */
export function InvoicingTab() {
  const [view] = useState('this_week');

  return (
    <div className={s.tab}>
      <div className={s.viewToggle}>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`${s.viewBtn} ${view === v.id ? s.viewBtnActive : ''}`}
            disabled={view === v.id}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === 'this_week' && <ThisWeekView />}
    </div>
  );
}
