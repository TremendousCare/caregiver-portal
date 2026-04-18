import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getAvailability,
  addAvailability,
  removeAvailability,
  updateAvailability,
} from './storage';
import {
  emptyGrid,
  rowsToGrid,
  gridToRows,
  diffAvailabilityRows,
  slotToDisplayTime,
  summarizeWeeklyAvailability,
  DAY_LABELS,
  DAY_LABELS_LONG,
  SLOTS_PER_DAY,
  DAYS_PER_WEEK,
} from './availabilityHelpers';
import btn from '../../styles/buttons.module.css';
import s from './AvailabilityEditor.module.css';

// ═══════════════════════════════════════════════════════════════
// AvailabilityEditor — Phase 3
//
// Per-caregiver weekly availability editor. Renders a 7×48 half-hour
// grid that the user click-and-drags to mark available time blocks,
// plus a list of one-off time off entries (vacation, sick days).
//
// State flow:
//   1. On mount: fetch all rows from caregiver_availability for this
//      caregiver → split into grid (recurring available) + oneOffRows.
//   2. User edits staged state (grid + oneOffRows + pendingAdds + pendingRemovals).
//   3. On Save: diff staged vs. original, issue add/remove calls.
//   4. Refetch on save success so the UI reflects database reality.
//
// The grid only handles recurring AVAILABLE blocks. Recurring unavailable
// rows and any date-range entries are shown in the "Time off" list below
// the grid. This keeps the visual grid simple.
// ═══════════════════════════════════════════════════════════════

export function AvailabilityEditor({ caregiver, currentUserName, showToast }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [originalRows, setOriginalRows] = useState([]);
  const [grid, setGrid] = useState(() => emptyGrid());
  const [oneOffRows, setOneOffRows] = useState([]);
  const [saving, setSaving] = useState(false);

  // Drag state for click-and-drag selection on the grid.
  const dragStateRef = useRef({ active: false, mode: 'add' });
  const [dragTick, setDragTick] = useState(0); // force re-render on drag

  // One-off add form (inline)
  const [showAddTimeOff, setShowAddTimeOff] = useState(false);
  const [timeOffForm, setTimeOffForm] = useState({
    startDate: '',
    endDate: '',
    reason: '',
  });

  // ─── Load on mount ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rows = await getAvailability(caregiver.id);
        if (cancelled) return;
        setOriginalRows(rows);
        // Convert DB rows (camelCase from storage) → DB-shape (snake_case)
        // for the helpers. The helpers were written against the DB column
        // names so the raw rows from storage don't match directly.
        const shaped = rows.map(appRowToHelperRow);
        const { grid: g, oneOffRows: o } = rowsToGrid(shaped);
        setGrid(g);
        setOneOffRows(o.map((row) => helperRowToAppRow(row, rows)));
        setLoaded(true);
      } catch (e) {
        console.error('Failed to load availability:', e);
        if (!cancelled) {
          setLoadError(e.message || 'Failed to load availability');
          setLoaded(true);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [caregiver.id]);

  // ─── Dirty check ─────────────────────────────────────────────
  const isDirty = useMemo(() => {
    if (!loaded) return false;
    // Compare current grid-derived rows vs. original recurring rows
    const currentRecurring = gridToRows(grid); // helper-shape (snake_case)
    const originalRecurring = originalRows
      .filter((r) => r.dayOfWeek !== null && r.dayOfWeek !== undefined && r.type === 'available')
      .map(appRowToHelperRow);
    const { toAdd, toRemove } = diffAvailabilityRows(originalRecurring, currentRecurring);
    if (toAdd.length > 0 || toRemove.length > 0) return true;

    // Compare one-off lists (ids and key fields)
    const origOneOff = originalRows.filter(
      (r) => !(r.dayOfWeek !== null && r.dayOfWeek !== undefined && r.type === 'available'),
    );
    if (origOneOff.length !== oneOffRows.length) return true;
    for (const r of oneOffRows) {
      if (!r.id) return true; // staged add
    }
    const origIds = new Set(origOneOff.map((r) => r.id));
    const currIds = new Set(oneOffRows.filter((r) => r.id).map((r) => r.id));
    for (const id of origIds) {
      if (!currIds.has(id)) return true;
    }
    return false;
  }, [loaded, grid, originalRows, oneOffRows]);

  // ─── Grid click / drag ───────────────────────────────────────
  const toggleCell = useCallback((dow, slot, forcedMode = null) => {
    setGrid((prev) => {
      const next = prev.map((row) => row.slice());
      const current = next[dow][slot];
      const newValue = forcedMode === null ? !current : forcedMode === 'add';
      next[dow][slot] = newValue;
      return next;
    });
  }, []);

  const handleCellMouseDown = useCallback(
    (dow, slot) => (e) => {
      e.preventDefault();
      const currentValue = grid[dow][slot];
      const mode = currentValue ? 'remove' : 'add';
      dragStateRef.current = { active: true, mode };
      toggleCell(dow, slot, mode);
      setDragTick((t) => t + 1);
    },
    [grid, toggleCell],
  );

  const handleCellMouseEnter = useCallback(
    (dow, slot) => () => {
      if (!dragStateRef.current.active) return;
      toggleCell(dow, slot, dragStateRef.current.mode);
    },
    [toggleCell],
  );

  // Stop drag on any mouse-up globally
  useEffect(() => {
    const handleUp = () => {
      if (dragStateRef.current.active) {
        dragStateRef.current = { active: false, mode: 'add' };
      }
    };
    window.addEventListener('mouseup', handleUp);
    return () => window.removeEventListener('mouseup', handleUp);
  }, []);

  // ─── Row actions ─────────────────────────────────────────────
  const handleClearAll = () => {
    if (!window.confirm('Clear all weekly availability for this caregiver?')) return;
    setGrid(emptyGrid());
  };

  const handlePresetWeekdays = () => {
    // Mon-Fri 8am-4pm (slots 16..32 exclusive)
    const next = emptyGrid();
    for (let dow = 1; dow <= 5; dow++) {
      for (let s = 16; s < 32; s++) next[dow][s] = true;
    }
    setGrid(next);
  };

  // ─── Time off actions ────────────────────────────────────────
  const handleAddTimeOff = () => {
    if (!timeOffForm.startDate) {
      showToast?.('Please enter a start date');
      return;
    }
    const newRow = {
      // No id yet — staged for insert
      caregiverId: caregiver.id,
      type: 'unavailable',
      dayOfWeek: null,
      startDate: timeOffForm.startDate,
      endDate: timeOffForm.endDate || timeOffForm.startDate,
      reason: timeOffForm.reason || null,
      createdBy: currentUserName || null,
    };
    setOneOffRows((prev) => [...prev, newRow]);
    setTimeOffForm({ startDate: '', endDate: '', reason: '' });
    setShowAddTimeOff(false);
  };

  const handleRemoveTimeOff = (row, index) => {
    setOneOffRows((prev) => prev.filter((r, i) => i !== index));
  };

  // Toggle the pin flag on an existing time-off row. Only applies to
  // saved rows (rows with an id). Pinned rows are protected from being
  // overwritten when the caregiver submits a new availability survey.
  const handleTogglePin = async (row) => {
    if (!row.id) return;
    const nextPinned = !row.pinned;
    try {
      const updated = await updateAvailability(row.id, { pinned: nextPinned });
      setOriginalRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...updated } : r)));
      setOneOffRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...updated } : r)));
      showToast?.(nextPinned ? 'Pinned — will not be overwritten by surveys' : 'Unpinned');
    } catch (e) {
      console.error('Failed to toggle pin:', e);
      showToast?.(`Failed to update pin: ${e.message || e}`);
    }
  };

  // ─── Save ────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    try {
      // 1. Recurring diff
      const currentRecurring = gridToRows(grid);
      const originalRecurring = originalRows
        .filter((r) => r.dayOfWeek !== null && r.dayOfWeek !== undefined && r.type === 'available')
        .map(appRowToHelperRow);
      const { toAdd: recurringAdds, toRemove: recurringRemoves } =
        diffAvailabilityRows(originalRecurring, currentRecurring);

      // 2. One-off diff — each oneOffRow without an id is a new add;
      //    each original row not in current is a removal.
      const originalOneOffIds = new Set(
        originalRows
          .filter((r) => !(r.dayOfWeek !== null && r.dayOfWeek !== undefined && r.type === 'available'))
          .map((r) => r.id),
      );
      const currentIds = new Set(oneOffRows.filter((r) => r.id).map((r) => r.id));
      const oneOffAdds = oneOffRows.filter((r) => !r.id);
      const oneOffRemoves = [...originalOneOffIds].filter((id) => !currentIds.has(id));

      // 3. Execute in a safe order: deletes first, then inserts.
      for (const id of [...recurringRemoves, ...oneOffRemoves]) {
        await removeAvailability(id);
      }
      for (const row of recurringAdds) {
        await addAvailability({
          caregiverId: caregiver.id,
          type: 'available',
          dayOfWeek: row.day_of_week,
          startTime: row.start_time,
          endTime: row.end_time === '24:00' ? '23:59:59' : row.end_time,
          // Manual edits in the UI are tagged 'manual' so they're
          // distinguishable from survey-imported rows. Pinning remains
          // an explicit per-row action — manual edits do NOT auto-pin.
          source: 'manual',
          pinned: false,
          createdBy: currentUserName || null,
        });
      }
      for (const row of oneOffAdds) {
        await addAvailability({
          caregiverId: caregiver.id,
          type: row.type,
          dayOfWeek: null,
          startDate: row.startDate,
          endDate: row.endDate,
          reason: row.reason,
          source: 'manual',
          pinned: false,
          createdBy: currentUserName || null,
        });
      }

      // 4. Refetch to get the authoritative state with real IDs.
      const fresh = await getAvailability(caregiver.id);
      setOriginalRows(fresh);
      const shaped = fresh.map(appRowToHelperRow);
      const { grid: g, oneOffRows: o } = rowsToGrid(shaped);
      setGrid(g);
      setOneOffRows(o.map((row) => helperRowToAppRow(row, fresh)));

      showToast?.('Availability saved');
    } catch (e) {
      console.error('Save failed:', e);
      showToast?.(`Save failed: ${e.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  // ─── Render ──────────────────────────────────────────────────
  if (!loaded) {
    return <div className={s.loading}>Loading availability…</div>;
  }

  if (loadError) {
    return (
      <div className={s.errorBanner}>
        Could not load availability: {loadError}
      </div>
    );
  }

  const summary = summarizeWeeklyAvailability(grid);
  const hourRows = HOUR_ROWS_FOR_DISPLAY; // slot pairs for hourly rows

  const hasSurveyRows = originalRows.some((r) => r.source === 'survey');

  return (
    <div className={s.editor}>
      {hasSurveyRows && (
        <div style={{
          background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8,
          padding: '10px 14px', marginBottom: 12, fontSize: 12, color: '#1E40AF',
        }}>
          Some rows below were imported from the caregiver's availability survey.
          Future survey submissions will replace all unpinned rows. Use the pin
          icon to keep a row across submissions.
        </div>
      )}
      <div className={s.toolbar}>
        <div className={s.toolbarInfo}>
          <h3 className={s.sectionTitle}>Weekly availability</h3>
          <p className={s.sectionSubtitle}>
            Click and drag cells to mark {caregiver.firstName} as available. Each cell is
            30&nbsp;minutes.
          </p>
        </div>
        <div className={s.toolbarButtons}>
          <button className={btn.secondaryBtn} onClick={handlePresetWeekdays}>
            Mon-Fri 8a-4p
          </button>
          <button className={btn.secondaryBtn} onClick={handleClearAll}>
            Clear all
          </button>
        </div>
      </div>

      <div className={s.gridWrap}>
        <div className={s.grid} role="grid" aria-label="Weekly availability grid">
          {/* Empty corner */}
          <div className={s.headerCell} />
          {/* Day headers */}
          {DAY_LABELS.map((label, dow) => (
            <div key={`h-${dow}`} className={s.headerCell} title={DAY_LABELS_LONG[dow]}>
              {label}
            </div>
          ))}

          {/* Rows: one row per 30-min slot. Label shown only on whole-hour slots. */}
          {hourRows.map((row) => (
            <Row
              key={row.slot}
              slot={row.slot}
              label={row.slot % 2 === 0 ? slotToDisplayTime(row.slot) : ''}
              isHourStart={row.slot % 2 === 0}
              grid={grid}
              onMouseDown={handleCellMouseDown}
              onMouseEnter={handleCellMouseEnter}
              dragTick={dragTick}
            />
          ))}
        </div>
      </div>

      <div className={s.summary} role="status">
        {summary}
      </div>

      <div className={s.divider} />

      <div className={s.toolbar}>
        <div className={s.toolbarInfo}>
          <h3 className={s.sectionTitle}>Time off</h3>
          <p className={s.sectionSubtitle}>
            Vacation, sick days, or any one-off unavailability. Overrides the weekly
            availability on those dates.
          </p>
        </div>
        <div className={s.toolbarButtons}>
          {!showAddTimeOff && (
            <button
              className={btn.secondaryBtn}
              onClick={() => setShowAddTimeOff(true)}
            >
              + Add time off
            </button>
          )}
        </div>
      </div>

      {showAddTimeOff && (
        <div className={s.timeOffForm}>
          <div className={s.timeOffFormRow}>
            <label className={s.fieldLabel}>
              Start date
              <input
                className={s.fieldInput}
                type="date"
                value={timeOffForm.startDate}
                onChange={(e) =>
                  setTimeOffForm({ ...timeOffForm, startDate: e.target.value })
                }
              />
            </label>
            <label className={s.fieldLabel}>
              End date
              <input
                className={s.fieldInput}
                type="date"
                value={timeOffForm.endDate}
                onChange={(e) =>
                  setTimeOffForm({ ...timeOffForm, endDate: e.target.value })
                }
              />
            </label>
            <label className={s.fieldLabel}>
              Reason
              <input
                className={s.fieldInput}
                type="text"
                placeholder="vacation, sick, etc."
                value={timeOffForm.reason}
                onChange={(e) =>
                  setTimeOffForm({ ...timeOffForm, reason: e.target.value })
                }
              />
            </label>
          </div>
          <div className={s.timeOffFormActions}>
            <button className={btn.secondaryBtn} onClick={() => {
              setShowAddTimeOff(false);
              setTimeOffForm({ startDate: '', endDate: '', reason: '' });
            }}>
              Cancel
            </button>
            <button className={btn.primaryBtn} onClick={handleAddTimeOff}>
              Add
            </button>
          </div>
        </div>
      )}

      {oneOffRows.length === 0 ? (
        <div className={s.empty}>No time off entered.</div>
      ) : (
        <ul className={s.oneOffList}>
          {oneOffRows.map((row, index) => (
            <li key={row.id || `staged-${index}`} className={s.oneOffItem}>
              <div className={s.oneOffText}>
                <strong>{formatOneOffLabel(row)}</strong>
                {row.reason && <span className={s.oneOffReason}> — {row.reason}</span>}
                {row.source === 'survey' && (
                  <span
                    title="Self-reported by the caregiver in their availability survey — unverified"
                    style={badgeStyle}
                  >
                    Self-reported
                  </span>
                )}
                {!row.id && <span className={s.oneOffPending}> (unsaved)</span>}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {row.id && (
                  <button
                    onClick={() => handleTogglePin(row)}
                    aria-label={row.pinned ? 'Unpin' : 'Pin'}
                    title={
                      row.pinned
                        ? 'Pinned — survey submissions will not overwrite this row. Click to unpin.'
                        : 'Click to pin — will be preserved on future availability surveys.'
                    }
                    style={row.pinned ? pinActiveStyle : pinStyle}
                  >
                    {row.pinned ? '📌' : '📍'}
                  </button>
                )}
                <button
                  className={s.oneOffRemove}
                  onClick={() => handleRemoveTimeOff(row, index)}
                  aria-label="Remove time off"
                  title="Remove"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className={s.footer}>
        <div className={s.dirtyNote}>
          {isDirty
            ? 'You have unsaved changes.'
            : 'All changes saved.'}
        </div>
        <button
          className={btn.primaryBtn}
          disabled={!isDirty || saving}
          onClick={handleSave}
        >
          {saving ? 'Saving…' : 'Save availability'}
        </button>
      </div>
    </div>
  );
}

// ─── Inline badge / pin styles ─────────────────────────────────

const badgeStyle = {
  display: 'inline-block',
  marginLeft: 8,
  padding: '2px 8px',
  borderRadius: 10,
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  background: '#FFFBEB',
  color: '#A16207',
  border: '1px solid #FDE68A',
  verticalAlign: 'middle',
};

const pinBaseStyle = {
  background: 'none',
  border: '1px solid #E0E4EA',
  borderRadius: 6,
  cursor: 'pointer',
  padding: '4px 6px',
  fontSize: 13,
  lineHeight: 1,
  fontFamily: 'inherit',
};

const pinStyle = { ...pinBaseStyle, opacity: 0.5 };
const pinActiveStyle = {
  ...pinBaseStyle,
  background: '#FEF3C7',
  borderColor: '#FDE68A',
  opacity: 1,
};

// ─── Helpers private to this file ──────────────────────────────

// Pre-compute the per-hour rows for display. Each hour displays two
// 30-minute cells stacked vertically. For simplicity we render one
// row per slot and only show the time label on whole-hour slots.
const HOUR_ROWS_FOR_DISPLAY = Array.from({ length: SLOTS_PER_DAY }, (_, slot) => ({
  slot,
}));

/**
 * Convert a storage-layer availability row (camelCase) into the
 * helper-expected DB-column shape (snake_case) so the pure helpers
 * that were written against the DB column names can consume them.
 */
function appRowToHelperRow(row) {
  return {
    id: row.id,
    type: row.type,
    day_of_week: row.dayOfWeek,
    start_time: row.startTime,
    end_time: row.endTime,
    start_date: row.startDate,
    end_date: row.endDate,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    reason: row.reason,
    source: row.source ?? null,
    pinned: row.pinned === true,
    source_response_id: row.sourceResponseId ?? null,
  };
}

/**
 * Match a helper-shape row back to its corresponding app-shape row
 * from the original fetched list, so the UI keeps the real id for
 * one-off rows (needed for delete on save).
 */
function helperRowToAppRow(helperRow, originalRows) {
  // Try to find the exact matching original by key fields.
  const match = originalRows.find((r) => {
    if (r.type !== helperRow.type) return false;
    if (helperRow.day_of_week !== null && helperRow.day_of_week !== undefined) {
      return (
        r.dayOfWeek === helperRow.day_of_week &&
        r.startTime === helperRow.start_time &&
        r.endTime === helperRow.end_time
      );
    }
    return (
      r.startDate === helperRow.start_date &&
      r.endDate === helperRow.end_date &&
      (r.reason || null) === (helperRow.reason || null)
    );
  });
  if (match) return { ...match };
  return {
    type: helperRow.type,
    dayOfWeek: helperRow.day_of_week,
    startTime: helperRow.start_time,
    endTime: helperRow.end_time,
    startDate: helperRow.start_date,
    endDate: helperRow.end_date,
    reason: helperRow.reason,
  };
}

function formatOneOffLabel(row) {
  if (row.dayOfWeek !== null && row.dayOfWeek !== undefined) {
    return `${DAY_LABELS_LONG[row.dayOfWeek] || 'Day'}: ${row.startTime || '?'}-${row.endTime || '?'} (${row.type})`;
  }
  if (row.startDate && row.endDate && row.startDate !== row.endDate) {
    return `${row.startDate} → ${row.endDate}`;
  }
  return row.startDate || 'Unknown';
}

// Row is extracted so React doesn't rebuild every cell on every drag tick —
// only the row the user is interacting with. Each row is one 30-min slot.
function Row({ slot, label, isHourStart, grid, onMouseDown, onMouseEnter }) {
  return (
    <>
      <div className={`${s.timeCell} ${isHourStart ? s.timeCellHour : ''}`}>
        {label}
      </div>
      {Array.from({ length: DAYS_PER_WEEK }, (_, dow) => {
        const active = grid[dow][slot];
        return (
          <div
            key={`${dow}-${slot}`}
            className={`${s.cell} ${active ? s.cellActive : ''} ${isHourStart ? s.cellHourStart : ''}`}
            onMouseDown={onMouseDown(dow, slot)}
            onMouseEnter={onMouseEnter(dow, slot)}
            role="gridcell"
            aria-selected={active}
          />
        );
      })}
    </>
  );
}
