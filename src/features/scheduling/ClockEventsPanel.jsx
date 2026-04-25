import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  getClockEventsForShift,
  insertManualClockEvent,
  updateClockEventTime,
  deleteManualClockEvent,
  updateShift,
} from './storage';
import {
  combineDateAndTimeToIso,
  computeShiftActuals,
  computeShiftVariance,
  formatClockEventTime,
  formatDurationMs,
  formatLocalTimeShort,
  isoToDateInput,
  isoToTimeInput,
  nextStatusForManualClockEvent,
} from './shiftHelpers';
import { DEFAULT_APP_TIMEZONE } from '../../lib/scheduling/timezone';
import btn from '../../styles/buttons.module.css';
import s from './ClockEventsPanel.module.css';

// ═══════════════════════════════════════════════════════════════
// ClockEventsPanel — "Time on shift" section of the ShiftDrawer
//
// Shows the caregiver's actual clock in / out vs. the scheduled
// times, plus the full event log with geofence override notes.
// Office staff can correct a wrong time, add a missed punch, and
// remove an erroneously added manual entry. All edits stamp
// edited_at / edited_by / edit_reason for audit; the very first
// occurred_at value is preserved in original_occurred_at on the
// first edit so payroll can always answer "what did the caregiver
// actually clock vs. what did the office change it to".
//
// Auto-recorded rows (source='caregiver_app') can be edited but
// not deleted. Manual rows can be edited or deleted.
// ═══════════════════════════════════════════════════════════════

const eventTypeLabel = (t) => (t === 'in' ? 'Clock in' : t === 'out' ? 'Clock out' : t);

export function ClockEventsPanel({
  shiftId,
  caregiverId,
  shiftStatus,
  scheduledStart,
  scheduledEnd,
  currentUserName,
  timezone = DEFAULT_APP_TIMEZONE,
  disabled = false,
  onShiftUpdated,
}) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const load = useCallback(async () => {
    if (!shiftId) return;
    setLoading(true);
    setLoadError(null);
    try {
      // Scope to the currently-assigned caregiver. Without this, a
      // reassigned shift would surface the previous caregiver's
      // punches in the summary and edit list.
      const rows = await getClockEventsForShift(shiftId, { caregiverId });
      setEvents(rows);
    } catch (e) {
      console.error('Load clock events failed:', e);
      setLoadError(e.message || 'Failed to load clock events.');
    } finally {
      setLoading(false);
    }
  }, [shiftId, caregiverId]);

  useEffect(() => {
    load();
    setEditingId(null);
    setShowAddForm(false);
  }, [load]);

  useEffect(() => {
    if (!supabase || !shiftId) return undefined;
    const channel = supabase
      .channel(`clock-events-${shiftId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'clock_events',
          filter: `shift_id=eq.${shiftId}`,
        },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [shiftId, load]);

  const actuals = useMemo(() => computeShiftActuals(events), [events]);

  const variance = useMemo(
    () =>
      computeShiftVariance(
        { startTime: scheduledStart, endTime: scheduledEnd, status: shiftStatus },
        actuals,
      ),
    [scheduledStart, scheduledEnd, shiftStatus, actuals],
  );

  const scheduledLine = useMemo(() => {
    if (!scheduledStart || !scheduledEnd) return null;
    return `${formatClockEventTime(scheduledStart, timezone)} – ${formatLocalTimeShort(
      new Date(scheduledEnd),
      timezone,
    )}`;
  }, [scheduledStart, scheduledEnd, timezone]);

  const actualLine = useMemo(() => {
    if (!actuals.actualStart) return null;
    const startLabel = formatClockEventTime(actuals.actualStart, timezone);
    if (!actuals.actualEnd) {
      return `${startLabel} – still on shift`;
    }
    return `${startLabel} – ${formatLocalTimeShort(new Date(actuals.actualEnd), timezone)}`;
  }, [actuals, timezone]);

  return (
    <section className={s.panel}>
      <div className={s.panelHeader}>
        <strong className={s.panelTitle}>Time on shift</strong>
        {!disabled && caregiverId && !showAddForm && (
          <button
            type="button"
            className={s.addBtn}
            onClick={() => {
              setShowAddForm(true);
              setEditingId(null);
            }}
          >
            Add clock event
          </button>
        )}
      </div>

      <dl className={s.summary}>
        <div className={s.summaryRow}>
          <dt>Scheduled</dt>
          <dd>{scheduledLine || '—'}</dd>
        </div>
        <div className={s.summaryRow}>
          <dt>Actual</dt>
          <dd>
            {actualLine || <span className={s.muted}>No clock events yet</span>}
            {actuals.durationMs != null && (
              <span className={s.durationBadge}>{formatDurationMs(actuals.durationMs)}</span>
            )}
            {actuals.isOpen && (
              <span className={s.openBadge}>On the clock</span>
            )}
            {variance.hasVariance && (
              <span
                className={`${s.varianceBadge} ${s[`variance_${variance.primaryFlag}`] || ''}`}
                title={varianceTooltip(variance)}
              >
                {variance.primaryLabel}
              </span>
            )}
          </dd>
        </div>
      </dl>

      {showAddForm && (
        <ManualEventForm
          mode="add"
          timezone={timezone}
          defaultIso={scheduledStart}
          onCancel={() => setShowAddForm(false)}
          onSubmit={async ({ eventType, occurredAt, reason }) => {
            await insertManualClockEvent({
              shiftId,
              caregiverId,
              eventType,
              occurredAt,
              editedBy: currentUserName || null,
              editReason: reason,
            });
            // Mirror the auto-transition the caregiver-clock edge
            // function performs on real clock-ins/outs: a manual 'in'
            // moves the shift to in_progress, a manual 'out' to
            // completed. Without this, the calendar would still show
            // the shift as 'assigned' even though clock activity exists.
            const nextStatus = nextStatusForManualClockEvent(shiftStatus, eventType);
            if (nextStatus) {
              try {
                const updated = await updateShift(shiftId, { status: nextStatus });
                onShiftUpdated?.(updated);
              } catch (statusErr) {
                // Status transition is best-effort — the clock event
                // itself is already saved. Surface the error but
                // don't undo the insert.
                console.warn('Status transition failed after manual clock event:', statusErr);
              }
            }
            setShowAddForm(false);
            await load();
          }}
        />
      )}

      {loadError && <div className={s.errorBox}>{loadError}</div>}

      <ul className={s.eventList}>
        {events.length === 0 && !loading && (
          <li className={s.emptyRow}>
            No clock activity for this shift yet.
          </li>
        )}
        {events.map((ev) => (
          <li key={ev.id} className={s.eventRow}>
            {editingId === ev.id ? (
              <ManualEventForm
                mode="edit"
                timezone={timezone}
                defaultIso={ev.occurredAt}
                fixedEventType={ev.eventType}
                onCancel={() => setEditingId(null)}
                onSubmit={async ({ occurredAt, reason }) => {
                  await updateClockEventTime(ev.id, {
                    occurredAt,
                    editedBy: currentUserName || null,
                    editReason: reason,
                  });
                  setEditingId(null);
                  await load();
                }}
                onDelete={
                  ev.source === 'manual_entry'
                    ? async () => {
                        await deleteManualClockEvent(ev.id);
                        setEditingId(null);
                        await load();
                      }
                    : null
                }
              />
            ) : (
              <ClockEventRow
                event={ev}
                timezone={timezone}
                disabled={disabled}
                onEdit={() => {
                  setEditingId(ev.id);
                  setShowAddForm(false);
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ClockEventRow({ event, timezone, disabled, onEdit }) {
  const isManual = event.source === 'manual_entry';
  const wasEdited = !!event.editedAt;
  const overrideReason = event.overrideReason;
  const geofenceFailed =
    event.geofencePassed === false && event.source === 'caregiver_app';

  return (
    <div className={s.eventRowInner}>
      <div className={s.eventMain}>
        <span className={s.eventType}>{eventTypeLabel(event.eventType)}</span>
        <span className={s.eventTime}>{formatClockEventTime(event.occurredAt, timezone)}</span>
        <div className={s.eventBadges}>
          {isManual && <span className={s.tagManual}>Manual entry</span>}
          {wasEdited && <span className={s.tagEdited}>Edited</span>}
          {geofenceFailed && <span className={s.tagOverride}>Geofence override</span>}
        </div>
        {!disabled && (
          <button type="button" className={s.editBtn} onClick={onEdit}>
            Edit
          </button>
        )}
      </div>

      {overrideReason && (
        <div className={s.eventDetail}>
          <span className={s.detailLabel}>Override reason</span>
          <span className={s.detailBody}>{overrideReason}</span>
        </div>
      )}

      {wasEdited && (
        <div className={s.eventDetail}>
          <span className={s.detailLabel}>
            Edited{event.editedBy ? ` by ${event.editedBy}` : ''}
          </span>
          <span className={s.detailBody}>
            {event.editReason || '—'}
            {event.originalOccurredAt && (
              <>
                {' '}
                <span className={s.muted}>
                  · originally {formatClockEventTime(event.originalOccurredAt, timezone)}
                </span>
              </>
            )}
          </span>
        </div>
      )}

      {isManual && !wasEdited && event.editReason && (
        <div className={s.eventDetail}>
          <span className={s.detailLabel}>
            Added{event.editedBy ? ` by ${event.editedBy}` : ''}
          </span>
          <span className={s.detailBody}>{event.editReason}</span>
        </div>
      )}
    </div>
  );
}

function ManualEventForm({
  mode,
  defaultIso,
  fixedEventType,
  timezone,
  onCancel,
  onSubmit,
  onDelete,
}) {
  const [eventType, setEventType] = useState(fixedEventType || 'in');
  const [dateStr, setDateStr] = useState(() => isoToDateInput(defaultIso, timezone) || '');
  const [timeStr, setTimeStr] = useState(() => isoToTimeInput(defaultIso, timezone) || '');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!dateStr || !timeStr) {
      setError('Pick a date and time.');
      return;
    }
    if (!reason.trim()) {
      setError('Please add a short reason for the audit log.');
      return;
    }
    const iso = combineDateAndTimeToIso(dateStr, timeStr, timezone);
    if (!iso) {
      setError('Invalid date or time.');
      return;
    }
    setSaving(true);
    try {
      await onSubmit({ eventType, occurredAt: iso, reason: reason.trim() });
    } catch (err) {
      console.error('Save clock event failed:', err);
      setError(err.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    if (!window.confirm('Remove this manual clock event? This cannot be undone.')) return;
    setSaving(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      console.error('Delete clock event failed:', err);
      setError(err.message || 'Delete failed.');
      setSaving(false);
    }
  };

  return (
    <form className={s.form} onSubmit={handleSubmit}>
      <div className={s.formTitle}>
        {mode === 'add' ? 'Add clock event' : 'Edit clock event'}
      </div>

      {mode === 'add' && (
        <label className={s.field}>
          <span className={s.fieldLabel}>Type</span>
          <select
            className={s.input}
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            disabled={saving}
          >
            <option value="in">Clock in</option>
            <option value="out">Clock out</option>
          </select>
        </label>
      )}

      <div className={s.fieldRow}>
        <label className={s.field}>
          <span className={s.fieldLabel}>Date</span>
          <input
            type="date"
            className={s.input}
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
            disabled={saving}
          />
        </label>
        <label className={s.field}>
          <span className={s.fieldLabel}>Time</span>
          <input
            type="time"
            className={s.input}
            value={timeStr}
            onChange={(e) => setTimeStr(e.target.value)}
            disabled={saving}
          />
        </label>
      </div>

      <label className={s.field}>
        <span className={s.fieldLabel}>
          Reason {mode === 'add' ? '(why was this added manually?)' : '(why is this being changed?)'}
        </span>
        <input
          type="text"
          className={s.input}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={
            mode === 'add'
              ? 'e.g. caregiver forgot to clock in'
              : 'e.g. correcting time per caregiver report'
          }
          disabled={saving}
          maxLength={200}
        />
      </label>

      {error && <div className={s.errorBox}>{error}</div>}

      <div className={s.formActions}>
        {onDelete && (
          <button
            type="button"
            className={s.deleteBtn}
            onClick={handleDelete}
            disabled={saving}
          >
            Delete
          </button>
        )}
        <div className={s.formActionsRight}>
          <button
            type="button"
            className={btn.secondaryBtn}
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button type="submit" className={btn.primaryBtn} disabled={saving}>
            {saving ? 'Saving…' : mode === 'add' ? 'Add event' : 'Save changes'}
          </button>
        </div>
      </div>
    </form>
  );
}

function varianceTooltip(variance) {
  const parts = [];
  if (variance.lateStartMinutes > 0) {
    parts.push(`Clocked in ${variance.lateStartMinutes} min after scheduled start`);
  }
  if (variance.overtimeMinutes > 0) {
    parts.push(`Clocked out ${variance.overtimeMinutes} min after scheduled end`);
  }
  if (variance.undertimeMinutes > 0) {
    parts.push(`Clocked out ${variance.undertimeMinutes} min before scheduled end`);
  }
  return parts.join(' · ');
}
