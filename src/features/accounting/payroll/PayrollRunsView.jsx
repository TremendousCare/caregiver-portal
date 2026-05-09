import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../../shared/context/AppContext';
import {
  downloadPayrollRun,
  getPayrollRunDetail,
  listPayrollRuns,
  markPayrollRunPaid,
} from '../storage';
import { MarkAsPaidModal } from './MarkAsPaidModal';
import s from './PayrollRunsView.module.css';

const RUN_STATUS_LABELS = {
  draft: 'Draft',
  exported: 'Exported',
  submitted: 'Submitted',
  processing: 'Processing',
  completed: 'Paid',
  failed: 'Failed',
};

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

function formatDate(iso) {
  if (!iso) return '—';
  // YYYY-MM-DD or full ISO. Strip time portion if present.
  const d = String(iso).slice(0, 10);
  return d;
}

function caregiverDisplayName(caregiver, fallback) {
  if (!caregiver) return fallback || '(Unknown caregiver)';
  const parts = [caregiver.firstName, caregiver.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : (fallback || '(Unnamed)');
}

/**
 * Phase 4 PR #3 — Payroll Runs history view.
 *
 * Lists every payroll_runs row for the org, most-recent first. A row
 * click expands a detail panel showing the run's member timesheets,
 * a "Download CSV" button, and a "Mark as Paid in Paychex" flow for
 * exported / submitted runs.
 *
 * Plan reference:
 *   docs/plans/2026-04-25-paychex-integration-plan.md
 *   docs/handoff-paychex-phase-4.md  ("PR #3")
 */
export function PayrollRunsView() {
  const { currentOrgId, showToast } = useApp();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [runs, setRuns] = useState([]);
  const [reloadCounter, setReloadCounter] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [details, setDetails] = useState(new Map());
  const [busyId, setBusyId] = useState(null);
  const [markPaidRun, setMarkPaidRun] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!currentOrgId) {
        setLoading(false);
        setRuns([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const fetched = await listPayrollRuns({ orgId: currentOrgId });
        if (!cancelled) setRuns(fetched);
      } catch (err) {
        if (!cancelled) setError(err?.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [currentOrgId, reloadCounter]);

  function reload() {
    setReloadCounter((n) => n + 1);
    // Drop cached details so the expanded panel re-fetches.
    setDetails(new Map());
  }

  async function handleToggleExpand(run) {
    if (expandedId === run.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(run.id);
    if (!details.has(run.id)) {
      try {
        const detail = await getPayrollRunDetail({
          orgId: currentOrgId,
          payrollRunId: run.id,
        });
        setDetails((m) => {
          const next = new Map(m);
          next.set(run.id, detail);
          return next;
        });
      } catch (err) {
        showToast?.(`Failed to load run detail: ${err.message}`);
      }
    }
  }

  async function handleDownload(run) {
    setBusyId(run.id);
    try {
      const result = await downloadPayrollRun(run.id);
      if (result?.csv_signed_url && typeof window !== 'undefined') {
        const a = document.createElement('a');
        a.href = result.csv_signed_url;
        a.target = '_blank';
        a.rel = 'noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else {
        showToast?.('Download URL was empty.');
      }
    } catch (err) {
      showToast?.(`Download failed: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  function handleMarkAsPaid(run) {
    setMarkPaidRun(run);
  }

  async function handleMarkAsPaidConfirm({ paidDate, notes }) {
    if (!markPaidRun) return;
    setBusyId(markPaidRun.id);
    try {
      const result = await markPayrollRunPaid({
        payrollRunId: markPaidRun.id,
        paidDate,
        notes,
      });
      const flipped = result?.member_timesheets_flipped ?? 0;
      showToast?.(
        flipped > 0
          ? `Run marked paid. ${flipped} member timesheet${flipped === 1 ? '' : 's'} flipped to paid.`
          : 'Run marked paid (legacy run — member timesheets not auto-flipped).',
      );
      setMarkPaidRun(null);
      reload();
    } catch (err) {
      showToast?.(`Mark as Paid failed: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={s.view}>
      {error && (
        <div className={s.errorBanner}>
          Failed to load payroll runs: {error}
        </div>
      )}

      {loading ? (
        <div className={s.empty}>Loading payroll runs…</div>
      ) : runs.length === 0 ? (
        <div className={s.empty}>
          No payroll runs yet.
          <div className={s.subtle}>
            Generate one from the &ldquo;This Week&rdquo; tab to populate this list.
          </div>
        </div>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th aria-label="Expand row" />
                <th className={s.thLeft}>Pay period</th>
                <th className={s.thLeft}>Pay date</th>
                <th className={s.thRight}>Caregivers</th>
                <th className={s.thRight}>Total gross</th>
                <th className={s.thLeft}>Status</th>
                <th className={s.thLeft}>Submitted by</th>
                <th className={s.thRight}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const expanded = expandedId === run.id;
                const detail = details.get(run.id);
                const isBusy = busyId === run.id;
                const canDownload = ['exported', 'submitted', 'processing', 'completed'].includes(run.status);
                const canMarkPaid = run.status === 'exported' || run.status === 'submitted';
                return (
                  <RunRow
                    key={run.id}
                    run={run}
                    expanded={expanded}
                    detail={detail}
                    isBusy={isBusy}
                    canDownload={canDownload}
                    canMarkPaid={canMarkPaid}
                    onToggleExpand={() => handleToggleExpand(run)}
                    onDownload={() => handleDownload(run)}
                    onMarkPaid={() => handleMarkAsPaid(run)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {markPaidRun && (
        <MarkAsPaidModal
          run={markPaidRun}
          onClose={() => setMarkPaidRun(null)}
          onConfirm={handleMarkAsPaidConfirm}
          busy={busyId === markPaidRun.id}
        />
      )}
    </div>
  );
}

// ─── Inner row component ─────────────────────────────────────────

function RunRow({
  run,
  expanded,
  detail,
  isBusy,
  canDownload,
  canMarkPaid,
  onToggleExpand,
  onDownload,
  onMarkPaid,
}) {
  const statusLabel = RUN_STATUS_LABELS[run.status] || run.status;

  const memberRows = useMemo(() => {
    if (!detail || !Array.isArray(detail.members)) return [];
    return detail.members;
  }, [detail]);

  return (
    <>
      <tr className={s.row}>
        <td className={s.expandCell}>
          <button
            type="button"
            className={s.expandBtn}
            onClick={onToggleExpand}
            aria-label={expanded ? 'Collapse run detail' : 'Expand run detail'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        </td>
        <td>
          <div className={s.periodLabel}>
            {formatDate(run.payPeriodStart)} &rarr; {formatDate(run.payPeriodEnd)}
          </div>
          <div className={s.subtle}>
            {run.submissionMode === 'csv_export' ? 'CSV export' : 'API submission'}
          </div>
        </td>
        <td>{formatDate(run.payDate)}</td>
        <td className={s.numCell}>{run.timesheetCount}</td>
        <td className={s.numCell}>
          <strong>{formatCurrency(run.totalGross)}</strong>
        </td>
        <td>
          <span className={`${s.statusBadge} ${s[`status_${run.status}`] || ''}`}>
            {statusLabel}
          </span>
        </td>
        <td>
          <div className={s.subtle}>{run.submittedBy || '—'}</div>
          <div className={s.subtle}>
            {run.submittedAt ? new Date(run.submittedAt).toLocaleString() : ''}
          </div>
        </td>
        <td className={s.actionsCell}>
          {canDownload && (
            <button
              type="button"
              className={s.actionBtn}
              onClick={onDownload}
              disabled={isBusy}
            >
              {isBusy ? 'Working…' : 'Download CSV'}
            </button>
          )}
          {canMarkPaid && (
            <button
              type="button"
              className={`${s.actionBtn} ${s.actionPrimary}`}
              onClick={onMarkPaid}
              disabled={isBusy}
            >
              Mark as Paid
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className={s.detailRow}>
          <td colSpan={8} className={s.detailCell}>
            {!detail ? (
              <div className={s.subtle}>Loading run detail…</div>
            ) : memberRows.length === 0 ? (
              <div className={s.subtle}>
                No member timesheets found.{' '}
                {run.status === 'exported' || run.status === 'completed'
                  ? 'This may be a pre-PR-3 legacy run that exported before timesheet linkage was tracked.'
                  : 'The run is too early in its lifecycle to have member timesheets yet.'}
              </div>
            ) : (
              <table className={s.detailTable}>
                <thead>
                  <tr>
                    <th>Caregiver</th>
                    <th>Status</th>
                    <th className={s.thRight}>Reg / OT / DT</th>
                    <th className={s.thRight}>Mileage</th>
                    <th className={s.thRight}>Gross</th>
                  </tr>
                </thead>
                <tbody>
                  {memberRows.map(({ timesheet, caregiver }) => (
                    <tr key={timesheet.id}>
                      <td>{caregiverDisplayName(caregiver, timesheet.caregiverId)}</td>
                      <td>
                        <span className={`${s.statusBadgeSm} ${s[`status_${timesheet.status}`] || ''}`}>
                          {timesheet.status}
                        </span>
                      </td>
                      <td className={s.numCell}>
                        {formatHours(timesheet.regularHours)}/
                        {formatHours(timesheet.overtimeHours)}/
                        {formatHours(timesheet.doubleTimeHours)}
                      </td>
                      <td className={s.numCell}>{formatHours(timesheet.mileageTotal)}</td>
                      <td className={s.numCell}>{formatCurrency(timesheet.grossPay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {run.completedAt && (
              <div className={s.subtle} style={{ marginTop: 8 }}>
                Marked paid at {new Date(run.completedAt).toLocaleString()}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
