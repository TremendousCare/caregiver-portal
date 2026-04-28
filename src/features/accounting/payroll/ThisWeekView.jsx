import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../../shared/context/AppContext';
import {
  approveTimesheetsBulk,
  getCaregiverDescriptors,
  getTimesheetsForPeriod,
  parseExceptionsFromNotes,
  priorWorkweek,
} from '../storage';
import {
  selectApprovableIds,
  TIMESHEET_STATUS,
} from '../../../lib/payroll/approvalStateMachine.js';
import { TimesheetRow } from './TimesheetRow';
import { GenerateRunModal } from './GenerateRunModal';
import s from './ThisWeekView.module.css';

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

/**
 * Phase 4 PR #2 — Edits + approval + Generate Run + CSV export.
 *
 * Builds on PR #1's read-only This Week view:
 *   - Per-row inline edit / Approve / Unapprove / Regenerate (in TimesheetRow).
 *   - Top-of-table Approve All Clean: bulk-approves every draft /
 *     pending_approval row that has no block-severity exceptions.
 *   - Top-of-table Generate Run: opens GenerateRunModal with the
 *     summary and dollar-typed confirmation gate. On confirm, calls
 *     payroll-export-run, marks rows as exported, and triggers a
 *     CSV download via the returned signed URL.
 *
 * Plan reference:
 *   docs/plans/2026-04-25-paychex-integration-plan.md
 *   docs/handoff-paychex-phase-4.md  ("PR #2")
 */
export function ThisWeekView() {
  const { currentOrgId, currentOrgSettings, showToast } = useApp();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);
  const [caregivers, setCaregivers] = useState(new Map());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);

  const period = useMemo(() => {
    const tz = currentOrgSettings?.payroll?.timezone || 'America/Los_Angeles';
    return priorWorkweek(new Date(), tz);
  }, [currentOrgSettings]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!currentOrgId) {
        setLoading(false);
        setRows([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const fetched = await getTimesheetsForPeriod({
          orgId: currentOrgId,
          payPeriodStart: period.start,
        });
        if (cancelled) return;

        const cgIds = Array.from(
          new Set(fetched.map((r) => r.timesheet.caregiverId).filter(Boolean)),
        );
        const cgMap = await getCaregiverDescriptors(cgIds);
        if (cancelled) return;

        setRows(fetched);
        setCaregivers(cgMap);
      } catch (err) {
        if (!cancelled) setError(err?.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [currentOrgId, period.start, reloadCounter]);

  function reload() {
    setReloadCounter((n) => n + 1);
  }

  const totals = useMemo(() => {
    let count = 0;
    let regular = 0;
    let overtime = 0;
    let doubleTime = 0;
    let mileage = 0;
    let gross = 0;
    let blocked = 0;
    let approved = 0;
    for (const { timesheet } of rows) {
      count += 1;
      regular += Number(timesheet.regularHours) || 0;
      overtime += Number(timesheet.overtimeHours) || 0;
      doubleTime += Number(timesheet.doubleTimeHours) || 0;
      mileage += Number(timesheet.mileageTotal) || 0;
      gross += Number(timesheet.grossPay) || 0;
      if (timesheet.status === 'blocked') blocked += 1;
      if (timesheet.status === TIMESHEET_STATUS.APPROVED) approved += 1;
    }
    return { count, regular, overtime, doubleTime, mileage, gross, blocked, approved };
  }, [rows]);

  // Map<timesheetId, exceptions[]> for the approval gate helpers.
  const exceptionsByTimesheetId = useMemo(() => {
    const m = new Map();
    for (const { timesheet } of rows) {
      m.set(timesheet.id, parseExceptionsFromNotes(timesheet.notes));
    }
    return m;
  }, [rows]);

  // Approve All Clean: every draft / pending_approval row with no
  // block-severity exceptions becomes a candidate. Excludes
  // already-approved + blocked rows automatically.
  const approvableIds = useMemo(() => {
    const ts = rows.map(({ timesheet }) => ({ id: timesheet.id, status: timesheet.status }));
    return selectApprovableIds({ timesheets: ts, exceptionsByTimesheetId });
  }, [rows, exceptionsByTimesheetId]);

  const approvedTimesheets = useMemo(() =>
    rows
      .filter(({ timesheet }) => timesheet.status === TIMESHEET_STATUS.APPROVED)
      .map(({ timesheet }) => timesheet),
  [rows]);

  async function handleApproveAllClean() {
    if (approvableIds.length === 0 || bulkBusy) return;
    if (!window.confirm(
      `Approve ${approvableIds.length} clean timesheet${approvableIds.length === 1 ? '' : 's'}? ` +
      'Rows with block-severity exceptions are excluded.',
    )) return;
    setBulkBusy(true);
    try {
      const result = await approveTimesheetsBulk(approvableIds);
      const approved = result?.approved_count ?? 0;
      const failed = result?.failed_count ?? 0;
      showToast?.(
        failed > 0
          ? `Approved ${approved}; ${failed} failed (see console for details).`
          : `Approved ${approved} timesheet${approved === 1 ? '' : 's'}.`,
      );
      if (failed > 0) {
        console.warn('[ThisWeekView] bulk approve failures:', result.results);
      }
      reload();
    } catch (err) {
      showToast?.(`Bulk approve failed: ${err.message}`);
    } finally {
      setBulkBusy(false);
    }
  }

  function handleOpenGenerateModal() {
    if (approvedTimesheets.length === 0) {
      showToast?.('No approved timesheets to export. Approve at least one first.');
      return;
    }
    setShowGenerateModal(true);
  }

  function handleGenerateComplete(result) {
    setShowGenerateModal(false);
    showToast?.(
      result.dry_run
        ? `Dry-run CSV generated (${result.timesheet_count} timesheet${result.timesheet_count === 1 ? '' : 's'}).`
        : `Payroll run created. CSV download starting.`,
    );
    if (result.csv_signed_url && typeof window !== 'undefined') {
      // Trigger the browser download via an anchor click. The signed
      // URL has download=<filename> so the browser saves with the
      // right name even though the storage object id is a UUID.
      const a = document.createElement('a');
      a.href = result.csv_signed_url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    reload();
  }

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aBlocked = a.timesheet.status === 'blocked' ? 0 : 1;
      const bBlocked = b.timesheet.status === 'blocked' ? 0 : 1;
      if (aBlocked !== bBlocked) return aBlocked - bBlocked;
      const aName = caregivers.get(a.timesheet.caregiverId);
      const bName = caregivers.get(b.timesheet.caregiverId);
      const aDisplay = aName ? `${aName.lastName || ''} ${aName.firstName || ''}` : a.timesheet.caregiverId;
      const bDisplay = bName ? `${bName.lastName || ''} ${bName.firstName || ''}` : b.timesheet.caregiverId;
      return aDisplay.localeCompare(bDisplay);
    });
  }, [rows, caregivers]);

  // Determine whether the org is in dry-run mode for the env indicator.
  const envIndicator = currentOrgSettings?.payroll?.dry_run === true ? 'DRY-RUN' : 'PRODUCTION';

  return (
    <div className={s.view}>
      <div className={s.header}>
        <div>
          <div className={s.payPeriod}>
            Pay period: <strong>{period.start}</strong> &rarr; <strong>{period.end}</strong>
          </div>
          <div className={s.subtle}>
            {totals.approved > 0
              ? `${totals.approved} approved, ${approvableIds.length} ready to approve`
              : `${approvableIds.length} ready to approve`}
            {totals.blocked > 0 && ` · ${totals.blocked} blocked`}
          </div>
        </div>
        <div className={s.headerActions}>
          <span
            className={`${s.envIndicator} ${envIndicator === 'DRY-RUN' ? s.envDryRun : s.envProd}`}
            title="Org-level production / dry-run indicator (organizations.settings.payroll.dry_run)"
          >
            {envIndicator}
          </span>
          <button
            type="button"
            className={s.btn}
            onClick={handleApproveAllClean}
            disabled={bulkBusy || approvableIds.length === 0}
          >
            {bulkBusy ? 'Approving…' : `Approve All Clean (${approvableIds.length})`}
          </button>
          <button
            type="button"
            className={`${s.btn} ${s.btnPrimary}`}
            onClick={handleOpenGenerateModal}
            disabled={approvedTimesheets.length === 0}
          >
            Generate Payroll Run ({approvedTimesheets.length})
          </button>
        </div>
      </div>

      {error && (
        <div className={s.errorBanner}>
          Failed to load timesheets: {error}
        </div>
      )}

      {loading ? (
        <div className={s.empty}>Loading timesheets…</div>
      ) : rows.length === 0 ? (
        <div className={s.empty}>
          No timesheets for {period.start} &rarr; {period.end} yet.
          <div className={s.subtle}>
            The cron runs Monday 6 AM PT. If it&rsquo;s earlier in the week
            and you don&rsquo;t see drafts here, the prior workweek had no
            payable shifts.
          </div>
        </div>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th aria-label="Expand row" />
                <th className={s.thLeft}>Caregiver</th>
                <th className={s.thRight}>Reg</th>
                <th className={s.thRight}>OT</th>
                <th className={s.thRight}>DT</th>
                <th className={s.thRight}>Mileage</th>
                <th className={s.thRight}>Gross</th>
                <th className={s.thLeft}>Status</th>
                <th className={s.thLeft}>Exceptions</th>
                <th className={s.thRight}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(({ timesheet, shifts }) => (
                <TimesheetRow
                  key={timesheet.id}
                  timesheet={timesheet}
                  shifts={shifts}
                  caregiver={caregivers.get(timesheet.caregiverId)}
                  exceptions={parseExceptionsFromNotes(timesheet.notes)}
                  onChanged={reload}
                />
              ))}
            </tbody>
            <tfoot className={s.tfoot}>
              <tr>
                <td />
                <td className={s.totalLabel}>
                  {totals.count} caregiver{totals.count === 1 ? '' : 's'}
                  {totals.blocked > 0 && (
                    <span className={s.blockedCount}> · {totals.blocked} blocked</span>
                  )}
                </td>
                <td className={s.numCell}>{formatHours(totals.regular)}</td>
                <td className={s.numCell}>{formatHours(totals.overtime)}</td>
                <td className={s.numCell}>{formatHours(totals.doubleTime)}</td>
                <td className={s.numCell}>{formatHours(totals.mileage)}</td>
                <td className={s.numCell}>
                  <strong>{formatCurrency(totals.gross)}</strong>
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {showGenerateModal && (
        <GenerateRunModal
          approvedTimesheets={approvedTimesheets}
          payPeriodStart={period.start}
          payPeriodEnd={period.end}
          orgSettings={currentOrgSettings}
          onClose={() => setShowGenerateModal(false)}
          onComplete={handleGenerateComplete}
        />
      )}
    </div>
  );
}
