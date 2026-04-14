import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  getAvailabilityForCaregivers,
  getShiftsForCaregivers,
  getAssignmentsForClient,
  createShiftOffers,
  updateShift,
} from './storage';
import {
  rankCaregiversForShift,
  splitRankedList,
  formatEligibleReason,
  weekBoundsContaining,
} from './eligibilityRanking';
import {
  DEFAULT_BROADCAST_TEMPLATE,
  buildMergeFields,
  renderTemplate,
  validateBroadcastDraft,
} from './broadcastHelpers';
import { formatShiftTimeRange } from './shiftHelpers';
import btn from '../../styles/buttons.module.css';
import s from './BroadcastModal.module.css';

// ═══════════════════════════════════════════════════════════════
// BroadcastModal — Phase 5a
//
// Opens from the ShiftDrawer's "Broadcast" button on an open or
// assigned shift. Flow:
//   1. Fetch availability / shifts / assignments for all caregivers
//      in the active roster (same data as the Phase 4c picker, so
//      we can rank eligibility).
//   2. Pre-select eligible caregivers (manager can tweak).
//   3. Let manager edit the SMS template (defaults to DEFAULT_BROADCAST_TEMPLATE).
//   4. Show a live per-caregiver preview of the rendered message.
//   5. On send:
//        a. Invoke the existing bulk-sms edge function (one shared
//           message — placeholders are expanded per-recipient on
//           the client before the call).
//        b. Wait for per-recipient send results.
//        c. Insert shift_offers rows for successful sends only.
//        d. Update the shift status to 'offered' if it was 'open'.
//   6. Close the modal and refresh the drawer.
//
// Phase 5a does NOT handle inbound responses — that's 5b. For now,
// the drawer will show "Offered to N caregivers" and the scheduler
// has to manually watch RingCentral for replies.
// ═══════════════════════════════════════════════════════════════

const MESSAGE_CHAR_WARN_THRESHOLD = 160; // single-segment SMS length
const MESSAGE_CHAR_HARD_LIMIT = 1600;

export function BroadcastModal({
  shift,
  caregivers,
  client,
  currentUserName,
  currentUserEmail,
  onClose,
  onBroadcastSent,
  showToast,
}) {
  // ─── Eligibility data load ────────────────────────────────────
  const [availabilityByCaregiverId, setAvailabilityByCaregiverId] = useState({});
  const [shiftsByCaregiverId, setShiftsByCaregiverId] = useState({});
  const [assignmentsByCaregiverId, setAssignmentsByCaregiverId] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // ─── Draft state ──────────────────────────────────────────────
  const [template, setTemplate] = useState(DEFAULT_BROADCAST_TEMPLATE);
  const [recipientIds, setRecipientIds] = useState([]);
  const [showFiltered, setShowFiltered] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const caregiverIds = useMemo(
    () => (caregivers || []).map((c) => c.id).sort(),
    [caregivers],
  );
  const caregiverIdsKey = caregiverIds.join(',');

  // ─── Load data ────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!caregiverIds.length || !shift?.clientId || !shift?.startTime) return;
    setLoading(true);
    setLoadError(null);
    try {
      const weekBounds = weekBoundsContaining(new Date(shift.startTime));
      const windowStart = new Date(weekBounds.start.getTime() - 24 * 60 * 60 * 1000);
      const windowEnd = new Date(weekBounds.end.getTime() + 24 * 60 * 60 * 1000);

      const [availabilityRows, shiftsRows, assignmentRows] = await Promise.all([
        getAvailabilityForCaregivers(caregiverIds),
        getShiftsForCaregivers({
          caregiverIds,
          startDate: windowStart.toISOString(),
          endDate: windowEnd.toISOString(),
        }),
        getAssignmentsForClient(shift.clientId, { activeOnly: true }),
      ]);

      const availByCg = {};
      for (const row of availabilityRows) {
        if (!availByCg[row.caregiverId]) availByCg[row.caregiverId] = [];
        availByCg[row.caregiverId].push(row);
      }
      setAvailabilityByCaregiverId(availByCg);

      const shiftsByCg = {};
      for (const row of shiftsRows) {
        if (!shiftsByCg[row.assignedCaregiverId]) {
          shiftsByCg[row.assignedCaregiverId] = [];
        }
        shiftsByCg[row.assignedCaregiverId].push(row);
      }
      setShiftsByCaregiverId(shiftsByCg);

      const assignByCg = {};
      for (const row of assignmentRows) {
        if (!assignByCg[row.caregiverId]) assignByCg[row.caregiverId] = [];
        assignByCg[row.caregiverId].push(row);
      }
      setAssignmentsByCaregiverId(assignByCg);
    } catch (e) {
      console.error('BroadcastModal load failed:', e);
      setLoadError(e.message || 'Failed to load caregiver data');
    } finally {
      setLoading(false);
    }
  }, [caregiverIdsKey, shift?.clientId, shift?.startTime]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Ranking ──────────────────────────────────────────────────
  const ranked = useMemo(() => {
    if (!shift?.clientId || !shift?.startTime || !shift?.endTime) return [];
    const weekBounds = weekBoundsContaining(new Date(shift.startTime));
    if (!weekBounds) return [];
    return rankCaregiversForShift({
      proposed: {
        id: shift.id,
        clientId: shift.clientId,
        startTime: shift.startTime,
        endTime: shift.endTime,
      },
      caregivers,
      availabilityByCaregiverId,
      shiftsByCaregiverId,
      assignmentsByCaregiverId,
      weekStart: weekBounds.start,
      weekEnd: weekBounds.end,
    });
  }, [shift, caregivers, availabilityByCaregiverId, shiftsByCaregiverId, assignmentsByCaregiverId]);

  const { eligible, filtered } = useMemo(() => splitRankedList(ranked), [ranked]);

  // Pre-select all eligible caregivers once the data loads
  const initializedRef = useMemo(() => ({ current: false }), []);
  useEffect(() => {
    if (!initializedRef.current && eligible.length > 0) {
      setRecipientIds(eligible.map((e) => e.caregiver.id));
      initializedRef.current = true;
    }
  }, [eligible, initializedRef]);

  // ─── Preview / message rendering ──────────────────────────────
  const previewRecipient = useMemo(() => {
    if (recipientIds.length === 0) return null;
    const first = recipientIds[0];
    return caregivers.find((c) => c.id === first) || null;
  }, [recipientIds, caregivers]);

  const previewText = useMemo(() => {
    if (!previewRecipient) return '';
    const fields = buildMergeFields({
      shift,
      caregiver: previewRecipient,
      client,
    });
    return renderTemplate(template, fields);
  }, [template, shift, client, previewRecipient]);

  // ─── Selection handlers ─────────────────────────────────────
  const toggleRecipient = (id) => {
    setRecipientIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const selectAllEligible = () => {
    setRecipientIds(eligible.map((e) => e.caregiver.id));
  };

  const selectNone = () => {
    setRecipientIds([]);
  };

  // ─── Send ─────────────────────────────────────────────────────
  const handleSend = async () => {
    const draft = { recipientIds, template };
    const validationError = validateBroadcastDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (!supabase) {
      setError('Supabase is not configured.');
      return;
    }

    setSending(true);
    setError(null);

    try {
      // Render per-recipient messages by expanding placeholders using
      // each recipient's merge fields. We loop through them and send
      // one bulk-sms call per recipient with the single rendered
      // message, because bulk-sms sends the SAME message to all
      // caregivers in one call and doesn't support per-recipient
      // template expansion.
      //
      // For Phase 5a we optimize for correctness over request count.
      // Batching by shared message is a future optimization.

      const results = [];
      for (const recipientId of recipientIds) {
        const recipient = caregivers.find((c) => c.id === recipientId);
        if (!recipient) continue;
        const personalizedMessage = renderTemplate(
          template,
          buildMergeFields({ shift, caregiver: recipient, client }),
        );

        const { data, error: smsError } = await supabase.functions.invoke('bulk-sms', {
          body: {
            caregiver_ids: [recipientId],
            message: personalizedMessage,
            current_user: currentUserEmail || currentUserName || 'system',
            category: 'scheduling',
          },
        });

        if (smsError) {
          console.error('Broadcast SMS failed for', recipientId, smsError);
          results.push({ id: recipientId, status: 'failed', reason: smsError.message || 'failed' });
          continue;
        }

        const perResult = (data?.results || []).find((r) => r.id === recipientId);
        results.push({
          id: recipientId,
          status: perResult?.status || 'unknown',
          reason: perResult?.reason || null,
          message: personalizedMessage,
        });
      }

      // Insert shift_offers rows for the caregivers we actually
      // texted. Skip failed / skipped sends.
      const sentOffers = results
        .filter((r) => r.status === 'sent')
        .map((r) => ({
          shiftId: shift.id,
          caregiverId: r.id,
          status: 'sent',
          sentAt: new Date().toISOString(),
          notes: r.message,
          createdBy: currentUserName || currentUserEmail || null,
        }));

      if (sentOffers.length > 0) {
        await createShiftOffers(sentOffers);
      }

      // Move the shift to 'offered' if it was 'open'
      if (sentOffers.length > 0 && shift.status === 'open') {
        await updateShift(shift.id, { status: 'offered' });
      }

      const sentCount = results.filter((r) => r.status === 'sent').length;
      const failedCount = results.filter((r) => r.status !== 'sent').length;

      if (failedCount === 0 && sentCount > 0) {
        showToast?.(`Broadcast sent to ${sentCount} caregiver${sentCount === 1 ? '' : 's'}`);
        onBroadcastSent?.({ sentCount, failedCount, results });
        return;
      }

      // Something failed. Surface the real reason(s) inline in the
      // modal so the scheduler can diagnose and retry without losing
      // their selection.
      const failureReasons = results
        .filter((r) => r.status !== 'sent')
        .map((r) => {
          const recipient = caregivers.find((c) => c.id === r.id);
          const name = recipient
            ? `${recipient.firstName || ''} ${recipient.lastName || ''}`.trim() || r.id
            : r.id;
          return `${name}: ${r.reason || r.status || 'unknown error'}`;
        });

      const summary = sentCount > 0
        ? `Sent ${sentCount}, ${failedCount} failed:`
        : `Broadcast failed — no SMS sent.`;
      setError(`${summary}\n${failureReasons.join('\n')}`);

      // Still fire the callback so the drawer refreshes any partial writes.
      onBroadcastSent?.({ sentCount, failedCount, results, keepOpen: true });
    } catch (e) {
      console.error('Broadcast failed:', e);
      setError(e.message || 'Broadcast failed');
    } finally {
      setSending(false);
    }
  };

  // ─── Render ──────────────────────────────────────────────────
  const charCount = template.length;
  const overSoftLimit = charCount > MESSAGE_CHAR_WARN_THRESHOLD;
  const overHardLimit = charCount > MESSAGE_CHAR_HARD_LIMIT;
  const selectionCount = recipientIds.length;

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="broadcast-title">
        <header className={s.header}>
          <div>
            <h2 id="broadcast-title" className={s.title}>Broadcast shift</h2>
            <div className={s.subtitle}>{formatShiftTimeRange(shift)}</div>
          </div>
          <button className={s.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className={s.body}>
          {/* ─── Template editor ─── */}
          <section className={s.section}>
            <div className={s.sectionHeader}>
              <h3 className={s.sectionTitle}>Message</h3>
              <div className={s.charCount}>
                <span className={overHardLimit ? s.charOver : overSoftLimit ? s.charWarn : ''}>
                  {charCount}
                </span>{' '}
                chars
              </div>
            </div>
            <textarea
              className={s.templateInput}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              rows={3}
              placeholder="Message template — supports {{firstName}}, {{clientName}}, {{timeRange}}, {{location}}, etc."
            />
            {previewText && (
              <div className={s.preview}>
                <div className={s.previewLabel}>
                  Preview for {previewRecipient?.firstName || 'first recipient'}:
                </div>
                <div className={s.previewText}>{previewText}</div>
              </div>
            )}
          </section>

          {/* ─── Recipient picker ─── */}
          <section className={s.section}>
            <div className={s.sectionHeader}>
              <h3 className={s.sectionTitle}>
                Recipients{' '}
                <span className={s.selectionCount}>
                  ({selectionCount} selected{loading ? '' : ` of ${eligible.length} eligible`})
                </span>
              </h3>
              <div className={s.bulkActions}>
                <button type="button" className={s.linkBtn} onClick={selectAllEligible} disabled={loading}>
                  Select all eligible
                </button>
                <span className={s.linkSep}>·</span>
                <button type="button" className={s.linkBtn} onClick={selectNone}>
                  Clear
                </button>
              </div>
            </div>

            {loadError && <div className={s.error}>{loadError}</div>}
            {loading && <div className={s.loading}>Loading caregivers…</div>}

            {!loading && eligible.length === 0 && filtered.length === 0 && (
              <div className={s.empty}>No caregivers available.</div>
            )}

            {eligible.length > 0 && (
              <ul className={s.list}>
                {eligible.map((entry) => (
                  <RecipientRow
                    key={entry.caregiver.id}
                    entry={entry}
                    selected={recipientIds.includes(entry.caregiver.id)}
                    onToggle={() => toggleRecipient(entry.caregiver.id)}
                  />
                ))}
              </ul>
            )}

            {filtered.length > 0 && (
              <div className={s.filteredBlock}>
                <button
                  type="button"
                  className={s.filteredToggle}
                  onClick={() => setShowFiltered((v) => !v)}
                  aria-expanded={showFiltered}
                >
                  {showFiltered ? '▾' : '▸'} Filtered out ({filtered.length})
                </button>
                {showFiltered && (
                  <ul className={s.list}>
                    {filtered.map((entry) => (
                      <RecipientRow
                        key={entry.caregiver.id}
                        entry={entry}
                        selected={recipientIds.includes(entry.caregiver.id)}
                        onToggle={() => toggleRecipient(entry.caregiver.id)}
                        filtered
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          {error && <div className={s.error}>{error}</div>}
        </div>

        <footer className={s.footer}>
          <div className={s.footerNote}>
            {sending
              ? 'Sending…'
              : `${selectionCount} SMS${selectionCount === 1 ? '' : 'es'} will be sent via RingCentral`}
          </div>
          <div className={s.footerActions}>
            <button className={btn.secondaryBtn} onClick={onClose} disabled={sending}>
              Cancel
            </button>
            <button
              className={btn.primaryBtn}
              onClick={handleSend}
              disabled={sending || selectionCount === 0 || overHardLimit}
            >
              {sending ? 'Sending…' : `Send broadcast${selectionCount > 0 ? ` (${selectionCount})` : ''}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ─── Recipient row ────────────────────────────────────────────

function RecipientRow({ entry, selected, onToggle, filtered }) {
  const { caregiver, filterDetail } = entry;
  const name = `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim() || caregiver.id;
  const reason = filtered ? filterDetail : formatEligibleReason(entry);
  const hasPhone = !!caregiver.phone;

  return (
    <li className={`${s.row} ${selected ? s.rowSelected : ''} ${filtered ? s.rowFiltered : ''}`}>
      <label className={s.rowLabel}>
        <input
          type="checkbox"
          className={s.checkbox}
          checked={selected}
          onChange={onToggle}
          disabled={!hasPhone}
        />
        <span className={s.rowText}>
          <span className={s.rowName}>
            {name}
            {!hasPhone && <span className={s.noPhone}> — no phone</span>}
          </span>
          <span className={s.rowReason}>{reason}</span>
        </span>
      </label>
    </li>
  );
}
