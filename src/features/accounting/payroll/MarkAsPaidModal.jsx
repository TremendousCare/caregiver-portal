import { useState } from 'react';
import s from './MarkAsPaidModal.module.css';

function formatCurrency(n) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Phase 4 PR #3 — Mark as Paid modal.
 *
 * Confirms the actual paid date with the back office (defaults to
 * today, per owner answer to open question #2 in the handoff). Calls
 * onConfirm({ paidDate, notes }). The parent does the
 * payroll-mark-run-paid invocation + toast + reload.
 */
export function MarkAsPaidModal({ run, onClose, onConfirm, busy }) {
  const [paidDate, setPaidDate] = useState(todayIso());
  const [notes, setNotes] = useState('');

  const today = todayIso();
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(paidDate)
    && paidDate <= today
    && paidDate >= run.payPeriodEnd;

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className={s.title}>Mark as Paid in Paychex</h2>
        <p className={s.lede}>
          Confirms <strong>{run.timesheetCount} timesheet{run.timesheetCount === 1 ? '' : 's'}</strong>{' '}
          totaling <strong>{formatCurrency(run.totalGross)}</strong> have been paid out by Paychex
          for pay period {run.payPeriodStart} &rarr; {run.payPeriodEnd}.
        </p>
        <p className={s.lede}>
          The run flips to <strong>Paid</strong> and every member timesheet flips to <strong>paid</strong>.
          Both states are terminal — only undo this via SQL if you made a mistake.
        </p>

        <label className={s.field}>
          Paid date
          <input
            type="date"
            className={s.input}
            value={paidDate}
            onChange={(e) => setPaidDate(e.target.value)}
            min={run.payPeriodEnd}
            max={today}
            disabled={busy}
          />
          <span className={s.hint}>
            Defaults to today. Must be on or after {run.payPeriodEnd} and not in the future.
          </span>
        </label>

        <label className={s.field}>
          Notes (optional)
          <input
            type="text"
            className={s.input}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Confirmed in Paychex Flex; check #1234"
            disabled={busy}
          />
        </label>

        <div className={s.footer}>
          <button type="button" className={s.btn} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`${s.btn} ${s.btnPrimary}`}
            disabled={!dateValid || busy}
            onClick={() => onConfirm({ paidDate, notes })}
          >
            {busy ? 'Marking paid…' : 'Mark as Paid'}
          </button>
        </div>
      </div>
    </div>
  );
}
