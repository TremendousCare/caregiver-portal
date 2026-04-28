import { useState } from 'react';
import { ExceptionBadge } from './ExceptionBadge';
import s from './TimesheetRow.module.css';

const STATUS_LABELS = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  exported: 'Exported',
  submitted: 'Submitted',
  paid: 'Paid',
  rejected: 'Rejected',
  blocked: 'Blocked',
};

const HOUR_CLASSIFICATION_LABELS = {
  regular: 'Reg',
  overtime: 'OT',
  double_time: 'DT',
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

function caregiverDisplayName(caregiver) {
  if (!caregiver) return '(Unknown caregiver)';
  const parts = [caregiver.firstName, caregiver.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : '(Unnamed)';
}

export function TimesheetRow({ timesheet, shifts, caregiver, exceptions }) {
  const [expanded, setExpanded] = useState(false);

  const status = timesheet.status || 'draft';
  const statusLabel = STATUS_LABELS[status] || status;

  return (
    <>
      <tr className={`${s.row} ${status === 'blocked' ? s.rowBlocked : ''}`}>
        <td className={s.expandCell}>
          <button
            type="button"
            className={s.expandBtn}
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Collapse shift details' : 'Expand shift details'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        </td>
        <td className={s.nameCell}>
          <div className={s.name}>{caregiverDisplayName(caregiver)}</div>
          <div className={s.subtle}>
            {caregiver?.paychexEmployeeId
              ? `Employee ID ${caregiver.paychexEmployeeId}`
              : 'No Paychex employee ID'}
          </div>
        </td>
        <td className={s.numCell}>{formatHours(timesheet.regularHours)}</td>
        <td className={s.numCell}>{formatHours(timesheet.overtimeHours)}</td>
        <td className={s.numCell}>{formatHours(timesheet.doubleTimeHours)}</td>
        <td className={s.numCell}>{formatHours(timesheet.mileageTotal)}</td>
        <td className={s.numCell}>
          <strong>{formatCurrency(timesheet.grossPay)}</strong>
        </td>
        <td className={s.statusCell}>
          <span className={`${s.statusBadge} ${s[`status_${status}`] || ''}`}>
            {statusLabel}
          </span>
        </td>
        <td className={s.exceptionsCell}>
          {exceptions.length === 0 ? (
            <span className={s.subtle}>—</span>
          ) : (
            exceptions.map((ex, idx) => (
              <ExceptionBadge key={`${ex.code}_${ex.shift_id || idx}`} exception={ex} />
            ))
          )}
        </td>
      </tr>
      {expanded && (
        <tr className={s.detailRow}>
          <td colSpan={9} className={s.detailCell}>
            {shifts.length === 0 ? (
              <div className={s.subtle}>No shift line items recorded for this timesheet.</div>
            ) : (
              <table className={s.detailTable}>
                <thead>
                  <tr>
                    <th>Shift ID</th>
                    <th>Hours</th>
                    <th>Class</th>
                    <th>Mileage</th>
                  </tr>
                </thead>
                <tbody>
                  {shifts.map((sh) => (
                    <tr key={sh.shiftId}>
                      <td className={s.mono}>{sh.shiftId}</td>
                      <td>{formatHours(sh.hoursWorked)}</td>
                      <td>{HOUR_CLASSIFICATION_LABELS[sh.hourClassification] || sh.hourClassification}</td>
                      <td>{formatHours(sh.mileage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {timesheet.blockReason && (
              <div className={s.blockReason}>
                Block reason: <code>{timesheet.blockReason}</code>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
