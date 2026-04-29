import { useEffect, useState } from 'react';
import { ExceptionBadge } from './ExceptionBadge';
import {
  approveTimesheet,
  unapproveTimesheet,
  editTimesheetTotals,
  editShiftRate,
  editShiftMileage,
  regenerateTimesheet,
  getShiftDetails,
} from '../storage';
import { useApp } from '../../../shared/context/AppContext';
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

// Editable fields on the timesheet totals row. Mirrors the whitelist
// in the payroll-timesheet-actions edge function.
const EDITABLE_TOTAL_FIELDS = [
  { key: 'regular_hours', label: 'Reg hrs' },
  { key: 'overtime_hours', label: 'OT hrs' },
  { key: 'double_time_hours', label: 'DT hrs' },
  { key: 'mileage_total', label: 'Mileage' },
  { key: 'gross_pay', label: 'Gross pay' },
];

// Statuses that allow inline edits + regenerate. Mirrors the edge
// function gates so the UI doesn't show buttons that will fail.
const EDITABLE_STATUSES = new Set(['draft', 'pending_approval', 'blocked']);
const REGENERATABLE_STATUSES = new Set([
  'draft', 'pending_approval', 'approved', 'blocked', 'rejected',
]);

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

function formatRate(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function caregiverDisplayName(caregiver) {
  if (!caregiver) return '(Unknown caregiver)';
  const parts = [caregiver.firstName, caregiver.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : '(Unnamed)';
}

function hasBlockerExceptions(exceptions) {
  return exceptions.some((e) => e?.severity === 'block');
}

export function TimesheetRow({
  timesheet,
  shifts,
  caregiver,
  exceptions,
  onChanged,
}) {
  const { currentOrgId, showToast } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingField, setEditingField] = useState(null); // { type: 'total'|'shift_rate'|'shift_mileage', key/shiftId }
  const [editValue, setEditValue] = useState('');
  const [editReason, setEditReason] = useState('');
  const [shiftDetails, setShiftDetails] = useState(new Map());

  const status = timesheet.status || 'draft';
  const statusLabel = STATUS_LABELS[status] || status;
  const isEditable = EDITABLE_STATUSES.has(status);
  const canApprove = (status === 'draft' || status === 'pending_approval')
    && !hasBlockerExceptions(exceptions);
  const canUnapprove = status === 'approved';
  const canRegenerate = REGENERATABLE_STATUSES.has(status);

  // Lazy-load shift details when the row first expands so we have
  // hourly_rate / clock-in/out times for the inline edit UI.
  useEffect(() => {
    if (!expanded || shiftDetails.size > 0) return;
    let cancelled = false;
    (async () => {
      const ids = shifts.map((s) => s.shiftId).filter(Boolean);
      if (ids.length === 0) return;
      const map = await getShiftDetails({ orgId: currentOrgId, shiftIds: ids });
      if (!cancelled) setShiftDetails(map);
    })();
    return () => { cancelled = true; };
  }, [expanded, currentOrgId, shifts, shiftDetails.size]);

  // ─── Action handlers ──────────────────────────────────────────

  function startEdit({ type, key, shiftId, currentValue }) {
    setEditingField({ type, key, shiftId });
    setEditValue(currentValue == null ? '' : String(currentValue));
    setEditReason('');
  }

  function cancelEdit() {
    setEditingField(null);
    setEditValue('');
    setEditReason('');
  }

  async function saveEdit() {
    if (!editingField) return;
    if (editReason.trim().length === 0) {
      showToast?.('Reason is required for inline edits.');
      return;
    }
    const numValue = Number(editValue);
    if (!Number.isFinite(numValue) || numValue < 0) {
      showToast?.('Value must be a non-negative number.');
      return;
    }
    setBusy(true);
    try {
      if (editingField.type === 'total') {
        await editTimesheetTotals({
          timesheetId: timesheet.id,
          edits: { [editingField.key]: numValue },
          reason: editReason.trim(),
        });
      } else if (editingField.type === 'shift_rate') {
        await editShiftRate({
          timesheetId: timesheet.id,
          shiftId: editingField.shiftId,
          hourlyRate: numValue,
          reason: editReason.trim(),
        });
      } else if (editingField.type === 'shift_mileage') {
        await editShiftMileage({
          timesheetId: timesheet.id,
          shiftId: editingField.shiftId,
          mileage: numValue,
          reason: editReason.trim(),
        });
      }
      cancelEdit();
      // Force a reload of shift details after the next expand so the
      // row reflects the new value.
      setShiftDetails(new Map());
      onChanged?.();
    } catch (err) {
      showToast?.(`Edit failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (!canApprove) return;
    setBusy(true);
    try {
      await approveTimesheet(timesheet.id);
      onChanged?.();
    } catch (err) {
      showToast?.(`Approve failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleUnapprove() {
    if (!canUnapprove) return;
    setBusy(true);
    try {
      await unapproveTimesheet(timesheet.id);
      onChanged?.();
    } catch (err) {
      showToast?.(`Unapprove failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRegenerate() {
    if (!canRegenerate) return;
    if (!window.confirm(
      'Regenerate this timesheet from its current shifts? The existing draft and any inline edits to the timesheet totals will be replaced.',
    )) return;
    setBusy(true);
    try {
      await regenerateTimesheet({ timesheetId: timesheet.id, reason: 'Regenerated from ThisWeekView' });
      onChanged?.();
    } catch (err) {
      showToast?.(`Regenerate failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  // ─── Render ────────────────────────────────────────────────────

  const editingTotalKey = editingField?.type === 'total' ? editingField.key : null;

  function renderTotalCell(field, currentValue, displayValue) {
    if (editingTotalKey === field.key) {
      return (
        <td className={s.numCell}>
          <input
            className={s.inlineInput}
            type="number"
            step="0.01"
            min="0"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </td>
      );
    }
    return (
      <td
        className={`${s.numCell} ${isEditable ? s.editableCell : ''}`}
        title={isEditable ? `Click to edit ${field.label}` : undefined}
        onClick={isEditable && !busy
          ? () => startEdit({ type: 'total', key: field.key, currentValue })
          : undefined}
      >
        {displayValue}
      </td>
    );
  }

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
        {renderTotalCell(EDITABLE_TOTAL_FIELDS[0], timesheet.regularHours, formatHours(timesheet.regularHours))}
        {renderTotalCell(EDITABLE_TOTAL_FIELDS[1], timesheet.overtimeHours, formatHours(timesheet.overtimeHours))}
        {renderTotalCell(EDITABLE_TOTAL_FIELDS[2], timesheet.doubleTimeHours, formatHours(timesheet.doubleTimeHours))}
        {renderTotalCell(EDITABLE_TOTAL_FIELDS[3], timesheet.mileageTotal, formatHours(timesheet.mileageTotal))}
        {renderTotalCell(EDITABLE_TOTAL_FIELDS[4], timesheet.grossPay, <strong>{formatCurrency(timesheet.grossPay)}</strong>)}
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
        <td className={s.actionsCell}>
          {canApprove && (
            <button
              type="button"
              className={`${s.actionBtn} ${s.actionPrimary}`}
              onClick={handleApprove}
              disabled={busy}
            >
              Approve
            </button>
          )}
          {canUnapprove && (
            <button
              type="button"
              className={s.actionBtn}
              onClick={handleUnapprove}
              disabled={busy}
            >
              Unapprove
            </button>
          )}
          {canRegenerate && (
            <button
              type="button"
              className={s.actionBtn}
              onClick={handleRegenerate}
              disabled={busy}
              title="Re-run the engine on this caregiver's current shifts"
            >
              Regenerate
            </button>
          )}
        </td>
      </tr>

      {/* Inline-edit reason row — appears under the row being edited */}
      {editingField && (
        <tr className={s.editReasonRow}>
          <td colSpan={9} className={s.editReasonCell}>
            <div className={s.editReasonLine}>
              <label className={s.editReasonLabel}>
                Reason (required)
                <input
                  className={s.editReasonInput}
                  type="text"
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  placeholder="e.g. Adjusted per Jessica — corrected timesheet entry"
                  disabled={busy}
                />
              </label>
              <button type="button" className={`${s.actionBtn} ${s.actionPrimary}`}
                onClick={saveEdit}
                disabled={busy || editReason.trim().length === 0}>
                Save
              </button>
              <button type="button" className={s.actionBtn} onClick={cancelEdit} disabled={busy}>
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}

      {expanded && (
        <tr className={s.detailRow}>
          <td colSpan={9} className={s.detailCell}>
            {shifts.length === 0 ? (
              <div className={s.subtle}>No shift line items recorded for this timesheet.</div>
            ) : (
              <table className={s.detailTable}>
                <thead>
                  <tr>
                    <th>Shift</th>
                    <th>Hours</th>
                    <th>Class</th>
                    <th>Rate</th>
                    <th>Mileage</th>
                    {isEditable && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {shifts.map((sh) => {
                    const detail = shiftDetails.get(sh.shiftId);
                    const isEditingThisRate = editingField?.type === 'shift_rate'
                      && editingField.shiftId === sh.shiftId;
                    const isEditingThisMileage = editingField?.type === 'shift_mileage'
                      && editingField.shiftId === sh.shiftId;
                    return (
                      <tr key={sh.shiftId}>
                        <td>
                          <div className={s.mono}>{sh.shiftId}</div>
                          {detail?.startTime && (
                            <div className={s.subtle}>
                              {new Date(detail.startTime).toLocaleString()}
                              {' → '}
                              {detail.endTime ? new Date(detail.endTime).toLocaleString() : '?'}
                            </div>
                          )}
                        </td>
                        <td>{formatHours(sh.hoursWorked)}</td>
                        <td>{HOUR_CLASSIFICATION_LABELS[sh.hourClassification] || sh.hourClassification}</td>
                        <td>
                          {isEditingThisRate ? (
                            <input
                              className={s.inlineInput}
                              type="number"
                              step="0.01"
                              min="0"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              disabled={busy}
                              autoFocus
                            />
                          ) : (
                            formatRate(detail?.hourlyRate)
                          )}
                        </td>
                        <td>
                          {isEditingThisMileage ? (
                            <input
                              className={s.inlineInput}
                              type="number"
                              step="0.01"
                              min="0"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              disabled={busy}
                              autoFocus
                            />
                          ) : (
                            formatHours(sh.mileage)
                          )}
                        </td>
                        {isEditable && (
                          <td>
                            <button
                              type="button"
                              className={s.smallBtn}
                              disabled={busy}
                              onClick={() => startEdit({
                                type: 'shift_rate',
                                shiftId: sh.shiftId,
                                currentValue: detail?.hourlyRate ?? '',
                              })}
                            >
                              Rate
                            </button>
                            <button
                              type="button"
                              className={s.smallBtn}
                              disabled={busy}
                              onClick={() => startEdit({
                                type: 'shift_mileage',
                                shiftId: sh.shiftId,
                                currentValue: sh.mileage ?? 0,
                              })}
                            >
                              Mileage
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {timesheet.blockReason && (
              <div className={s.blockReason}>
                Block reason: <code>{timesheet.blockReason}</code>
              </div>
            )}
            {timesheet.lastEditedBy && (
              <div className={s.subtle} style={{ marginTop: 8 }}>
                Last edited {timesheet.lastEditedAt
                  ? `${new Date(timesheet.lastEditedAt).toLocaleString()} `
                  : ''}
                by {timesheet.lastEditedBy}
                {timesheet.lastEditReason ? ` — "${timesheet.lastEditReason}"` : ''}
              </div>
            )}
            {timesheet.regularByRate && timesheet.regularByRate.length > 1 && (
              <div className={s.subtle} style={{ marginTop: 8 }}>
                Multi-rate week — Hourly rows on the CSV:{' '}
                {timesheet.regularByRate.map((r) =>
                  `${formatHours(r.hours)}h @ ${formatRate(r.rate)}`,
                ).join(', ')}
                {timesheet.regularRateOfPay != null
                  && ` · weighted ROP ${formatRate(timesheet.regularRateOfPay)}`}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
