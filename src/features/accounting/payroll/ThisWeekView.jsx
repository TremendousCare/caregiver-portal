import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../../shared/context/AppContext';
import {
  getCaregiverDescriptors,
  getTimesheetsForPeriod,
  parseExceptionsFromNotes,
  priorWorkweek,
} from '../storage';
import { TimesheetRow } from './TimesheetRow';
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
 * Phase 4 PR #1 — read-only This Week view.
 *
 * Surfaces whatever drafts the Phase 3 cron most recently produced for
 * the prior Mon→Sun workweek, joined with caregiver names + Paychex
 * sync state and the per-timesheet exception list parsed from
 * `timesheets.notes`.
 *
 * No edits, no approve buttons, no Generate Run — those land in
 * PR #2. Sticky footer shows running totals (count, hours, gross)
 * because money totals are the most prominent UX element on every
 * payroll screen per the plan.
 */
export function ThisWeekView() {
  const { currentOrgId, currentOrgSettings } = useApp();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);
  const [caregivers, setCaregivers] = useState(new Map());

  // Compute the workweek once per render. The cron always populates
  // the most recently completed Mon→Sun workweek; matching that here
  // keeps the UI in sync with whatever the scheduled run produced.
  const period = useMemo(() => {
    const tz =
      currentOrgSettings?.payroll?.timezone || 'America/Los_Angeles';
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
    return () => {
      cancelled = true;
    };
  }, [currentOrgId, period.start]);

  const totals = useMemo(() => {
    let count = 0;
    let regular = 0;
    let overtime = 0;
    let doubleTime = 0;
    let mileage = 0;
    let gross = 0;
    let blocked = 0;
    for (const { timesheet } of rows) {
      count += 1;
      regular += Number(timesheet.regularHours) || 0;
      overtime += Number(timesheet.overtimeHours) || 0;
      doubleTime += Number(timesheet.doubleTimeHours) || 0;
      mileage += Number(timesheet.mileageTotal) || 0;
      gross += Number(timesheet.grossPay) || 0;
      if (timesheet.status === 'blocked') blocked += 1;
    }
    return { count, regular, overtime, doubleTime, mileage, gross, blocked };
  }, [rows]);

  const sortedRows = useMemo(() => {
    // Sort: blocked first (so exceptions surface to the top), then by
    // caregiver display name alphabetical. Stable on caregiver_id ties.
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

  return (
    <div className={s.view}>
      <div className={s.header}>
        <div>
          <div className={s.payPeriod}>
            Pay period: <strong>{period.start}</strong> &rarr; <strong>{period.end}</strong>
          </div>
          <div className={s.subtle}>
            Read-only view. Edits and approvals ship in PR #2.
          </div>
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
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
