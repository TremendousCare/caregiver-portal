import { useState } from 'react';
import { ThisWeekView } from './ThisWeekView';
import { PayrollRunsView } from './PayrollRunsView';
import { PayrollSettingsView } from './PayrollSettingsView';
import s from './PayrollTab.module.css';

const VIEWS = [
  { id: 'this_week', label: 'This Week' },
  { id: 'runs', label: 'Payroll Runs' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Phase 4 Payroll sub-tab. PR #1 added the segmented control + This
 * Week view. PR #2 wired the action-bearing buttons into This Week.
 * PR #3 lights up the remaining two sub-tabs:
 *   - Payroll Runs: historical batches + Download CSV + Mark as Paid
 *   - Settings: Pay Components, mileage rate, dry-run, connection
 *     status, pay period config (read-only in v1)
 */
export function PayrollTab() {
  const [view, setView] = useState('this_week');

  return (
    <div className={s.tab}>
      <div className={s.viewToggle}>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`${s.viewBtn} ${view === v.id ? s.viewBtnActive : ''}`}
            onClick={() => setView(v.id)}
            aria-pressed={view === v.id}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === 'this_week' && <ThisWeekView />}
      {view === 'runs' && <PayrollRunsView />}
      {view === 'settings' && <PayrollSettingsView />}
    </div>
  );
}
