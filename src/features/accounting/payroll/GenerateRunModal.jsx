import { useMemo, useState } from 'react';
import { exportPayrollRun } from '../storage';
import s from './GenerateRunModal.module.css';

// Determine the run mode the modal header advertises. PRODUCTION is the
// default; DRY-RUN can be triggered either by an org-level
// `payroll.dry_run` setting or a per-call body flag (the modal toggle
// lets the back office force a dry-run before the real export).
//
// Per the plan's "Cross-cutting reliability practices" #7, every
// payroll page header gets a PRODUCTION / DRY-RUN indicator so the
// two modes are impossible to confuse.
function determineEnvIndicator(orgSettings) {
  const flag = orgSettings?.payroll?.dry_run;
  return flag === true ? 'DRY-RUN' : 'PRODUCTION';
}

function formatCurrency(n) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatHours(n) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toFixed(2);
}

// Allow the user's typed gross to drift up to one cent from the
// computed total — covers rounding noise without weakening the gate.
const CONFIRMATION_TOLERANCE_USD = 0.01;

/**
 * Phase 4 PR #2 — Generate Payroll Run modal.
 *
 * Props:
 *   approvedTimesheets: Array<{ id, caregiverId, regularHours,
 *     overtimeHours, doubleTimeHours, mileageTotal, grossPay }>
 *   payPeriodStart / payPeriodEnd: 'YYYY-MM-DD' (display only)
 *   orgSettings: org's settings jsonb (drives the env indicator)
 *   onClose: () => void
 *   onComplete: (result) => void  // called with the export result on success
 */
export function GenerateRunModal({
  approvedTimesheets,
  payPeriodStart,
  payPeriodEnd,
  orgSettings,
  onClose,
  onComplete,
}) {
  const envIndicator = determineEnvIndicator(orgSettings);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [forceDryRun, setForceDryRun] = useState(envIndicator === 'DRY-RUN');

  const summary = useMemo(() => {
    let count = 0;
    let regular = 0;
    let overtime = 0;
    let doubleTime = 0;
    let mileage = 0;
    let gross = 0;
    for (const t of approvedTimesheets) {
      count += 1;
      regular += Number(t.regularHours) || 0;
      overtime += Number(t.overtimeHours) || 0;
      doubleTime += Number(t.doubleTimeHours) || 0;
      mileage += Number(t.mileageTotal) || 0;
      gross += Number(t.grossPay) || 0;
    }
    const totalHours = regular + overtime + doubleTime;
    return {
      count,
      regular,
      overtime,
      doubleTime,
      mileage,
      gross: Math.round(gross * 100) / 100,
      totalHours,
    };
  }, [approvedTimesheets]);

  const typedNumber = Number(confirmation.replace(/[^0-9.]/g, ''));
  const typedValid = Number.isFinite(typedNumber)
    && Math.abs(typedNumber - summary.gross) <= CONFIRMATION_TOLERANCE_USD;

  async function handleGenerate() {
    if (!typedValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await exportPayrollRun({
        timesheetIds: approvedTimesheets.map((t) => t.id),
        dryRun: forceDryRun,
      });
      onComplete?.(result);
    } catch (err) {
      setError(err.message || 'Export failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className={s.header}>
          <div>
            <h2 className={s.title}>Generate Payroll Run</h2>
            <div className={s.subtitle}>
              {payPeriodStart} &rarr; {payPeriodEnd}
            </div>
          </div>
          <span
            className={`${s.envIndicator} ${forceDryRun ? s.envDryRun : s.envProd}`}
          >
            {forceDryRun ? 'DRY-RUN' : envIndicator}
          </span>
        </div>

        <div className={s.summaryGrid}>
          <div className={s.summaryItem}>
            <div className={s.summaryLabel}>Caregivers</div>
            <div className={s.summaryValue}>{summary.count}</div>
          </div>
          <div className={s.summaryItem}>
            <div className={s.summaryLabel}>Total hours</div>
            <div className={s.summaryValue}>{formatHours(summary.totalHours)}</div>
            <div className={s.summarySubtle}>
              Reg {formatHours(summary.regular)} ·
              OT {formatHours(summary.overtime)} ·
              DT {formatHours(summary.doubleTime)}
            </div>
          </div>
          <div className={s.summaryItem}>
            <div className={s.summaryLabel}>Mileage</div>
            <div className={s.summaryValue}>{formatHours(summary.mileage)}</div>
          </div>
          <div className={`${s.summaryItem} ${s.summaryGross}`}>
            <div className={s.summaryLabel}>Total gross</div>
            <div className={s.summaryValue}>{formatCurrency(summary.gross)}</div>
          </div>
        </div>

        <div className={s.confirmation}>
          <label className={s.confirmationLabel}>
            Type the gross total in dollars to confirm:
            <input
              type="text"
              inputMode="decimal"
              className={s.confirmationInput}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={summary.gross.toFixed(2)}
              disabled={busy}
              autoFocus
            />
          </label>
          {confirmation.length > 0 && !typedValid && (
            <div className={s.confirmationHint}>
              Must match {formatCurrency(summary.gross)} (within $0.01).
            </div>
          )}
        </div>

        <label className={s.dryRunToggle}>
          <input
            type="checkbox"
            checked={forceDryRun}
            onChange={(e) => setForceDryRun(e.target.checked)}
            disabled={busy || envIndicator === 'DRY-RUN'}
          />
          {' '}Dry-run (generate CSV for preview only — no payroll_runs row, no status flips).
          {envIndicator === 'DRY-RUN' && (
            <span className={s.dryRunForced}>
              {' '}Org-level dry-run is on; force-disabled.
            </span>
          )}
        </label>

        {error && (
          <div className={s.errorBanner}>
            Export failed: {error}
          </div>
        )}

        <div className={s.footer}>
          <button type="button" className={s.btn} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`${s.btn} ${s.btnPrimary}`}
            onClick={handleGenerate}
            disabled={!typedValid || busy || summary.count === 0}
          >
            {busy
              ? 'Generating…'
              : forceDryRun
                ? 'Generate dry-run CSV'
                : 'Generate Run + Download CSV'}
          </button>
        </div>
      </div>
    </div>
  );
}
