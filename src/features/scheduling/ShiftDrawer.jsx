import { useEffect, useMemo, useState } from 'react';
import { updateShift, cancelShift } from './storage';
import {
  SHIFT_CANCEL_REASONS,
  buildShiftUpdatePatch,
  formatShiftTimeRange,
  shiftStatusColors,
  shiftStatusLabel,
  validateShiftDraft,
} from './shiftHelpers';
import { ShiftForm } from './ShiftForm';
import btn from '../../styles/buttons.module.css';
import s from './ShiftDrawer.module.css';

// ═══════════════════════════════════════════════════════════════
// ShiftDrawer — Phase 4b
//
// Slides in from the right when the user clicks a shift on the
// master calendar. Shows editable fields plus quick status
// shortcuts (mark confirmed, mark completed) and a cancel flow
// with a reason dropdown.
// ═══════════════════════════════════════════════════════════════

export function ShiftDrawer({
  shift,
  clients,
  caregivers,
  carePlans,
  currentUserName,
  onClose,
  onSaved,
  onCancelled,
  showToast,
}) {
  const [draft, setDraft] = useState(shift);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState(null);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  useEffect(() => {
    setDraft(shift);
    setError(null);
    setShowCancelForm(false);
    setCancelReason('');
  }, [shift]);

  const patch = useMemo(() => buildShiftUpdatePatch(shift, draft), [shift, draft]);
  const isDirty = Object.keys(patch).length > 0;
  const isCancelled = shift?.status === 'cancelled';

  const statusColors = shiftStatusColors(draft?.status);

  const handleSave = async () => {
    const validationError = validateShiftDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateShift(shift.id, patch);
      showToast?.('Shift saved');
      onSaved?.(updated);
    } catch (e) {
      console.error('Save shift failed:', e);
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleQuickStatus = async (nextStatus) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateShift(shift.id, { status: nextStatus });
      showToast?.(`Status → ${shiftStatusLabel(nextStatus)}`);
      onSaved?.(updated);
    } catch (e) {
      console.error('Quick status update failed:', e);
      showToast?.(`Update failed: ${e.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCancelShift = async () => {
    if (!cancelReason) {
      setError('Please pick a cancellation reason.');
      return;
    }
    setCancelling(true);
    setError(null);
    try {
      const updated = await cancelShift(shift.id, {
        reason: cancelReason,
        cancelledBy: currentUserName || null,
      });
      showToast?.('Shift cancelled');
      onCancelled?.(updated);
    } catch (e) {
      console.error('Cancel shift failed:', e);
      setError(e.message || 'Cancel failed');
    } finally {
      setCancelling(false);
    }
  };

  if (!shift) return null;

  return (
    <div className={s.backdrop} onClick={onClose}>
      <aside
        className={s.drawer}
        role="dialog"
        aria-labelledby="shift-drawer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={s.header}>
          <div className={s.headerMain}>
            <div className={s.headerTop}>
              <h2 id="shift-drawer-title" className={s.title}>
                Shift details
              </h2>
              <button
                className={s.closeBtn}
                onClick={onClose}
                aria-label="Close"
                title="Close"
              >
                ×
              </button>
            </div>
            <div className={s.headerMeta}>
              <span
                className={s.statusPill}
                style={{
                  background: statusColors.bg,
                  color: statusColors.fg,
                  borderColor: statusColors.border,
                }}
              >
                {shiftStatusLabel(draft?.status)}
              </span>
              <span className={s.timeRange}>{formatShiftTimeRange(draft)}</span>
            </div>
          </div>
        </header>

        <div className={s.body}>
          {!isCancelled && (
            <div className={s.quickActions}>
              <span className={s.quickActionsLabel}>Quick actions:</span>
              {draft.status === 'assigned' && (
                <button
                  className={s.linkBtn}
                  onClick={() => handleQuickStatus('confirmed')}
                  disabled={saving}
                >
                  Mark confirmed
                </button>
              )}
              {(draft.status === 'confirmed' || draft.status === 'in_progress') && (
                <button
                  className={s.linkBtn}
                  onClick={() => handleQuickStatus('completed')}
                  disabled={saving}
                >
                  Mark completed
                </button>
              )}
              {draft.status === 'confirmed' && (
                <button
                  className={s.linkBtn}
                  onClick={() => handleQuickStatus('in_progress')}
                  disabled={saving}
                >
                  Mark in progress
                </button>
              )}
              {draft.status === 'open' && draft.assignedCaregiverId && (
                <button
                  className={s.linkBtn}
                  onClick={() => handleQuickStatus('assigned')}
                  disabled={saving}
                >
                  Mark assigned
                </button>
              )}
            </div>
          )}

          {isCancelled && (
            <div className={s.cancelledBanner}>
              <strong>Cancelled.</strong>
              {shift.cancelReason && <> Reason: {shift.cancelReason}</>}
            </div>
          )}

          <ShiftForm
            draft={draft}
            onChange={setDraft}
            clients={clients}
            caregivers={caregivers}
            carePlans={carePlans}
            errorMessage={error}
          />

          {!isCancelled && showCancelForm && (
            <div className={s.cancelBox}>
              <div className={s.cancelTitle}>Cancel this shift?</div>
              <select
                className={s.cancelSelect}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              >
                <option value="">Select a reason…</option>
                {SHIFT_CANCEL_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <div className={s.cancelActions}>
                <button
                  className={btn.secondaryBtn}
                  onClick={() => {
                    setShowCancelForm(false);
                    setCancelReason('');
                  }}
                  disabled={cancelling}
                >
                  Never mind
                </button>
                <button
                  className={btn.dangerBtn}
                  onClick={handleCancelShift}
                  disabled={cancelling || !cancelReason}
                >
                  {cancelling ? 'Cancelling…' : 'Cancel shift'}
                </button>
              </div>
            </div>
          )}
        </div>

        <footer className={s.footer}>
          {!isCancelled && !showCancelForm && (
            <button
              className={s.dangerLink}
              onClick={() => setShowCancelForm(true)}
              disabled={saving}
            >
              Cancel shift
            </button>
          )}
          <div className={s.footerRight}>
            <button className={btn.secondaryBtn} onClick={onClose} disabled={saving}>
              Close
            </button>
            <button
              className={btn.primaryBtn}
              onClick={handleSave}
              disabled={saving || !isDirty || isCancelled}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
