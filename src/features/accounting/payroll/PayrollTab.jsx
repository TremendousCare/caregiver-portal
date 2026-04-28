import { useState } from 'react';
import { ThisWeekView } from './ThisWeekView';
import s from './PayrollTab.module.css';

const VIEWS = [
  { id: 'this_week', label: 'This Week' },
  // PR #2 will add 'runs' (Payroll Runs history) and PR #3 'settings'.
];

/**
 * Phase 4 PR #1 — Payroll sub-tab. Currently exposes only the
 * read-only This Week view; the segmented control is rendered now so
 * the layout stays consistent when PR #2 / #3 add Runs and Settings.
 */
export function PayrollTab() {
  const [view] = useState('this_week');

  return (
    <div className={s.tab}>
      <div className={s.viewToggle}>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`${s.viewBtn} ${view === v.id ? s.viewBtnActive : ''}`}
            // PR #1 only has one view; clicks are inert. The control
            // is here so PR #2 only changes onClick + state, not
            // layout.
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
