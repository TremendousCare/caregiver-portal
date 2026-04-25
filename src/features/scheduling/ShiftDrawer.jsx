import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  updateShift,
  cancelShift,
  getShiftOffersForShift,
  updateShiftOffer,
  getShifts,
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
import { ConfirmAssignDialog } from './ConfirmAssignDialog';
import { ClockEventsPanel } from './ClockEventsPanel';
import { DEFAULT_APP_TIMEZONE } from '../../lib/scheduling/timezone';
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
  servicePlans,
  currentUserName,
  currentUserEmail,
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
  // Phase 7: "Apply to all future shifts in this series" checkboxes
  // Default is OFF — per user decision, one-off edits are the safe default.
  const [applyToFutureEdits, setApplyToFutureEdits] = useState(false);
  const [applyToFutureCancel, setApplyToFutureCancel] = useState(false);
  const [offers, setOffers] = useState([]);

  useEffect(() => {
    setDraft(shift);
    setError(null);
    setShowCancelForm(false);
    setCancelReason('');
    setApplyToFutureEdits(false);
    setApplyToFutureCancel(false);
  }, [shift]);

  // Phase 7: is this shift part of a recurring series?
  const isRecurring = !!shift?.recurrenceGroupId;

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

      // Phase 7: if this shift is recurring AND the scheduler checked
      // "apply to all future", apply the same patch to every sibling
      // shift in the same recurrence group that starts after this one.
      // We skip time-based fields (startTime, endTime) when propagating
      // because those are unique per occurrence and would clobber
      // every future shift with this one's timestamp.
      if (isRecurring && applyToFutureEdits) {
        const propagable = { ...patch };
        delete propagable.startTime;
        delete propagable.endTime;
        // Only propagate if there's actually something non-time to apply
        if (Object.keys(propagable).length > 0) {
          const siblings = await getShifts({
            startDate: shift.startTime, // strictly after (inclusive) this shift's start
          });
          const futureSiblings = siblings.filter(
            (sib) =>
              sib.id !== shift.id &&
              sib.recurrenceGroupId === shift.recurrenceGroupId &&
              new Date(sib.startTime).getTime() > new Date(shift.startTime).getTime(),
          );
          for (const sib of futureSiblings) {
            try {
              await updateShift(sib.id, propagable);
            } catch (sibErr) {
              console.warn(`Failed to update sibling shift ${sib.id}:`, sibErr);
            }
          }
          showToast?.(`Shift saved · ${futureSiblings.length} future shifts updated`);
        } else {
          showToast?.('Shift saved (time-only changes are not applied to future shifts)');
        }
      } else {
        showToast?.('Shift saved');
      }

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

  // ─── Phase 5c: Open the Confirm & assign dialog ──────────────
  // Runs when the scheduler clicks "Assign this caregiver" on a
  // response row. The actual assignment happens inside
  // performAssignment() once the dialog's onConfirm fires.
  const [pendingAssignOffer, setPendingAssignOffer] = useState(null);

  const handleAssignFromOffer = (offer) => {
    if (!offer || !offer.caregiverId) return;
    const caregiver = caregivers?.find((c) => c.id === offer.caregiverId);
    if (!caregiver) {
      setError('Could not find caregiver record.');
      return;
    }
    setError(null);
    setPendingAssignOffer(offer);
  };

  // ─── Phase 5b/5c: Run the assignment + confirmation flow ────
  // Called when ConfirmAssignDialog fires onConfirm with the final
  // rendered confirmation message (possibly edited by the user).
  // Steps:
  //   1. Update the shift: status → assigned, assigned_caregiver_id
  //      → the responder.
  //   2. Mark the winning offer as 'assigned'.
  //   3. Expire all OTHER pending offers for this shift so the
  //      broadcast history clearly shows who "won".
  //   4. Send the (possibly edited) confirmation SMS via the
  //      existing bulk-sms function routed through the scheduling
  //      communication route.
  //   5. Refresh the drawer.
  const performAssignment = async ({ renderedMessage }) => {
    const offer = pendingAssignOffer;
    if (!offer) return;
    const caregiver = caregivers?.find((c) => c.id === offer.caregiverId);
    if (!caregiver) {
      setError('Could not find caregiver record.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // 1. Assign the shift
      const updated = await updateShift(shift.id, {
        assignedCaregiverId: offer.caregiverId,
        status: 'assigned',
      });

      // 2. Mark the winning offer as assigned
      await updateShiftOffer(offer.id, { status: 'assigned' });

      // 3. Expire all other pending offers for this shift
      const peersToExpire = offers.filter(
        (o) => o.id !== offer.id && (o.status === 'sent' || o.status === 'accepted'),
      );
      for (const peer of peersToExpire) {
        await updateShiftOffer(peer.id, { status: 'expired' });
      }

      // 4. Send the confirmation SMS (using the text from the dialog,
      //    which may have been edited by the scheduler)
      let smsFailed = false;
      if (supabase && caregiver.phone && renderedMessage && renderedMessage.trim()) {
        try {
          await supabase.functions.invoke('bulk-sms', {
            body: {
              caregiver_ids: [caregiver.id],
              message: renderedMessage,
              current_user: currentUserEmail || currentUserName || 'system',
              category: 'scheduling',
            },
          });
        } catch (smsErr) {
          console.warn('Confirmation SMS failed:', smsErr);
          smsFailed = true;
        }
      }

      if (smsFailed) {
        showToast?.('Shift assigned — confirmation SMS failed (check RingCentral)');
      } else {
        showToast?.(`Assigned to ${caregiver.firstName || 'caregiver'} · confirmation sent`);
      }
      setPendingAssignOffer(null);
      onSaved?.(updated);
    } catch (e) {
      console.error('Assign from offer failed:', e);
      setError(e.message || 'Failed to assign');
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

      // Phase 7: if this shift is recurring AND the scheduler checked
      // "apply to all future", cancel every sibling shift in the same
      // recurrence group that starts after this one.
      if (isRecurring && applyToFutureCancel) {
        const siblings = await getShifts({ startDate: shift.startTime });
        const futureSiblings = siblings.filter(
          (sib) =>
            sib.id !== shift.id &&
            sib.recurrenceGroupId === shift.recurrenceGroupId &&
            new Date(sib.startTime).getTime() > new Date(shift.startTime).getTime() &&
            sib.status !== 'cancelled',
        );
        for (const sib of futureSiblings) {
          try {
            await cancelShift(sib.id, {
              reason: cancelReason,
              cancelledBy: currentUserName || null,
            });
          } catch (sibErr) {
            console.warn(`Failed to cancel sibling shift ${sib.id}:`, sibErr);
          }
        }
        showToast?.(
          `Shift cancelled · ${futureSiblings.length} future shifts also cancelled`,
        );
      } else {
        showToast?.('Shift cancelled');
      }

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
              <span className={s.timeRange}>{formatShiftTimeRange(draft, DEFAULT_APP_TIMEZONE)}</span>
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
                  Broadcast shift
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
                  const canAssign =
                    offer.status === 'accepted' &&
                    !isCancelled &&
                    shift.status !== 'assigned' &&
                    shift.status !== 'confirmed' &&
                    shift.status !== 'in_progress' &&
                    shift.status !== 'completed';
                  return (
                    <li key={offer.id} className={s.offerRow}>
                      <div className={s.offerRowMain}>
                        <span className={s.offerName}>{name}</span>
                        <span className={`${s.offerStatus} ${s[`offerStatus_${offer.status}`] || ''}`}>
                          {offer.status}
                        </span>
                      </div>
                      {offer.responseText && (
                        <div className={s.offerResponseText}>
                          <span className={s.offerResponseLabel}>Replied:</span>{' '}
                          <span className={s.offerResponseBody}>"{offer.responseText}"</span>
                        </div>
                      )}
                      {canAssign && (
                        <div className={s.offerActions}>
                          <button
                            type="button"
                            className={s.assignBtn}
                            onClick={() => handleAssignFromOffer(offer)}
                            disabled={saving}
                          >
                            Assign {cg?.firstName || 'this caregiver'} →
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {shift.assignedCaregiverId && (
            <ClockEventsPanel
              shiftId={shift.id}
              caregiverId={shift.assignedCaregiverId}
              scheduledStart={shift.startTime}
              scheduledEnd={shift.endTime}
              currentUserName={currentUserName}
              timezone={DEFAULT_APP_TIMEZONE}
              disabled={isCancelled}
            />
          )}

          <ShiftForm
            draft={draft}
            onChange={setDraft}
            clients={clients}
            caregivers={caregivers}
            servicePlans={servicePlans}
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
              {isRecurring && (
                <label className={s.recurringCheckbox}>
                  <input
                    type="checkbox"
                    checked={applyToFutureCancel}
                    onChange={(e) => setApplyToFutureCancel(e.target.checked)}
                    disabled={cancelling}
                  />
                  <span>Also cancel all future shifts in this recurring series</span>
                </label>
              )}
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

        {isRecurring && isDirty && !isCancelled && (
          <div className={s.recurringEditBar}>
            <label className={s.recurringCheckbox}>
              <input
                type="checkbox"
                checked={applyToFutureEdits}
                onChange={(e) => setApplyToFutureEdits(e.target.checked)}
                disabled={saving}
              />
              <span>Also apply to all future shifts in this recurring series</span>
            </label>
          </div>
        )}

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

      {pendingAssignOffer && (
        <ConfirmAssignDialog
          shift={shift}
          caregiver={caregivers?.find((c) => c.id === pendingAssignOffer.caregiverId)}
          client={clients?.find((c) => c.id === shift.clientId) || null}
          sending={saving}
          onClose={() => {
            if (!saving) setPendingAssignOffer(null);
          }}
          onConfirm={performAssignment}
        />
      )}
    </div>
  );
}
