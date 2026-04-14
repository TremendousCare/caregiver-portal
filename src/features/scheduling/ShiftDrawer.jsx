import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  updateShift,
  cancelShift,
  getShiftOffersForShift,
} from './storage';
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
  onBroadcast,
  showToast,
}) {
  const [draft, setDraft] = useState(shift);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState(null);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [offers, setOffers] = useState([]);

  useEffect(() => {
    setDraft(shift);
    setError(null);
    setShowCancelForm(false);
    setCancelReason('');
  }, [shift]);

  // ─── Load shift offers for this shift ───────────────────────
  const loadOffers = useCallback(async () => {
    if (!shift?.id) return;
    try {
      const rows = await getShiftOffersForShift(shift.id);
      setOffers(rows);
    } catch (e) {
      console.error('Failed to load shift offers:', e);
    }
  }, [shift?.id]);

  useEffect(() => {
    loadOffers();
  }, [loadOffers]);

  // Realtime: watch for new/updated offers on this shift
  useEffect(() => {
    if (!supabase || !shift?.id) return undefined;
    const channel = supabase
      .channel(`shift-offers-${shift.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'shift_offers',
          filter: `shift_id=eq.${shift.id}`,
        },
        () => {
          loadOffers();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [shift?.id, loadOffers]);

  // ─── Offer summary counts ───────────────────────────────────
  const offerCounts = useMemo(() => {
    const counts = { total: 0, sent: 0, accepted: 0, declined: 0, expired: 0, assigned: 0 };
    for (const offer of offers) {
      counts.total++;
      if (counts[offer.status] != null) counts[offer.status]++;
    }
    return counts;
  }, [offers]);

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
              {(draft.status === 'open' || draft.status === 'offered') && (
                <button
                  className={s.linkBtn}
                  onClick={() => onBroadcast?.(shift)}
                  disabled={saving}
                >
                  📣 Broadcast shift
                </button>
              )}
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

          {offers.length > 0 && (
            <div className={s.offersBox}>
              <div className={s.offersHeader}>
                <strong>Broadcast history</strong>
                <span className={s.offersSummary}>
                  {offerCounts.total} offered
                  {offerCounts.sent > 0 && ` · ${offerCounts.sent} awaiting response`}
                  {offerCounts.accepted > 0 && ` · ${offerCounts.accepted} accepted`}
                  {offerCounts.declined > 0 && ` · ${offerCounts.declined} declined`}
                </span>
              </div>
              <ul className={s.offersList}>
                {offers.map((offer) => {
                  const cg = caregivers?.find((c) => c.id === offer.caregiverId);
                  const name = cg
                    ? `${cg.firstName || ''} ${cg.lastName || ''}`.trim() || cg.id
                    : offer.caregiverId;
                  return (
                    <li key={offer.id} className={s.offerRow}>
                      <span className={s.offerName}>{name}</span>
                      <span className={`${s.offerStatus} ${s[`offerStatus_${offer.status}`] || ''}`}>
                        {offer.status}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className={s.offersNote}>
                Inbound response tracking comes in Phase 5b. For now, watch RingCentral for
                replies and assign the caregiver manually.
              </div>
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
