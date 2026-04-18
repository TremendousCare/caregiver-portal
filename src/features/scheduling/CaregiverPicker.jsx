import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getAvailabilityForCaregivers,
  getShiftsForCaregivers,
  getAssignmentsForClient,
} from './storage';
import {
  rankCaregiversForShift,
  splitRankedList,
  formatEligibleReason,
  weekBoundsContaining,
} from './eligibilityRanking';
import { DEFAULT_APP_TIMEZONE } from '../../lib/scheduling/timezone';
import s from './CaregiverPicker.module.css';

// ═══════════════════════════════════════════════════════════════
// CaregiverPicker — Phase 4c
//
// Replaces the simple caregiver dropdown in ShiftForm with a
// ranked picker. Loads availability / shifts / assignments data
// for the full caregiver roster once, then computes eligibility
// and ranking in-memory as the proposed shift time changes.
//
// UI is split into two sections:
//   - Eligible (always visible)
//   - Filtered out (collapsed by default; click to expand)
//
// Filtered-out caregivers are still selectable — a warning badge
// shows why they were filtered, and picking one still assigns.
// This supports the "manager override" pattern where someone
// knows better than the data.
// ═══════════════════════════════════════════════════════════════

export function CaregiverPicker({
  caregivers,
  clientId,
  proposedStartTime,
  proposedEndTime,
  shiftId,
  value, // current assignedCaregiverId
  onChange,
}) {
  const [availabilityByCaregiverId, setAvailabilityByCaregiverId] = useState({});
  const [shiftsByCaregiverId, setShiftsByCaregiverId] = useState({});
  const [assignmentsByCaregiverId, setAssignmentsByCaregiverId] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [showFiltered, setShowFiltered] = useState(false);

  // Stabilize the caregiver id list so effects don't loop.
  const caregiverIds = useMemo(
    () => (caregivers || []).map((c) => c.id).sort(),
    [caregivers],
  );
  const caregiverIdsKey = caregiverIds.join(',');

  // Compute the fetch window for shifts (we need existing shifts
  // to detect conflicts AND to compute hours-this-week, so the
  // window is the larger of the two: ±1 week around the proposed
  // shift time).
  const fetchWindow = useMemo(() => {
    if (!proposedStartTime) return null;
    const anchor = new Date(proposedStartTime);
    if (Number.isNaN(anchor.getTime())) return null;
    const weekBounds = weekBoundsContaining(anchor);
    if (!weekBounds) return null;
    // Pad by 1 day on each side so shifts at week boundaries are caught
    const start = new Date(weekBounds.start.getTime() - 24 * 60 * 60 * 1000);
    const end = new Date(weekBounds.end.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }, [proposedStartTime]);

  // ─── Load data ───────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!caregiverIds.length || !fetchWindow || !clientId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [availabilityRows, shiftsRows, assignmentRows] = await Promise.all([
        getAvailabilityForCaregivers(caregiverIds),
        getShiftsForCaregivers({
          caregiverIds,
          startDate: fetchWindow.start.toISOString(),
          endDate: fetchWindow.end.toISOString(),
        }),
        getAssignmentsForClient(clientId, { activeOnly: true }),
      ]);

      // Group availability by caregiver
      const availByCg = {};
      for (const row of availabilityRows) {
        if (!availByCg[row.caregiverId]) availByCg[row.caregiverId] = [];
        availByCg[row.caregiverId].push(row);
      }
      setAvailabilityByCaregiverId(availByCg);

      // Group shifts by caregiver
      const shiftsByCg = {};
      for (const row of shiftsRows) {
        if (!shiftsByCg[row.assignedCaregiverId]) {
          shiftsByCg[row.assignedCaregiverId] = [];
        }
        shiftsByCg[row.assignedCaregiverId].push(row);
      }
      setShiftsByCaregiverId(shiftsByCg);

      // Group assignments by caregiver (for this client only)
      const assignByCg = {};
      for (const row of assignmentRows) {
        if (!assignByCg[row.caregiverId]) assignByCg[row.caregiverId] = [];
        assignByCg[row.caregiverId].push(row);
      }
      setAssignmentsByCaregiverId(assignByCg);
    } catch (e) {
      console.error('CaregiverPicker load failed:', e);
      setLoadError(e.message || 'Failed to load caregiver data');
    } finally {
      setLoading(false);
    }
  }, [caregiverIdsKey, clientId, fetchWindow?.start?.getTime(), fetchWindow?.end?.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Rank in-memory when inputs change ───────────────────────
  const ranked = useMemo(() => {
    if (!clientId || !proposedStartTime || !proposedEndTime) return [];
    const weekBounds = weekBoundsContaining(new Date(proposedStartTime));
    if (!weekBounds) return [];
    return rankCaregiversForShift({
      proposed: {
        id: shiftId,
        clientId,
        startTime: proposedStartTime,
        endTime: proposedEndTime,
      },
      caregivers,
      availabilityByCaregiverId,
      shiftsByCaregiverId,
      assignmentsByCaregiverId,
      weekStart: weekBounds.start,
      weekEnd: weekBounds.end,
      timezone: DEFAULT_APP_TIMEZONE,
    });
  }, [
    clientId,
    proposedStartTime,
    proposedEndTime,
    shiftId,
    caregivers,
    availabilityByCaregiverId,
    shiftsByCaregiverId,
    assignmentsByCaregiverId,
  ]);

  const { eligible, filtered } = useMemo(() => splitRankedList(ranked), [ranked]);

  const isNotReady = !clientId || !proposedStartTime || !proposedEndTime;

  const handlePick = (caregiverId) => {
    onChange(caregiverId);
  };

  // ─── Render ──────────────────────────────────────────────────
  if (isNotReady) {
    return (
      <div className={s.placeholder}>
        Pick a client and shift time to see eligible caregivers.
      </div>
    );
  }

  return (
    <div className={s.picker}>
      <div className={s.header}>
        <div className={s.headerTitle}>
          {loading ? 'Loading caregivers…' : `${eligible.length} eligible`}
        </div>
        <button
          type="button"
          className={s.clearBtn}
          onClick={() => handlePick(null)}
          disabled={!value}
        >
          Clear assignment
        </button>
      </div>

      {loadError && <div className={s.error}>{loadError}</div>}

      {!loading && eligible.length === 0 && filtered.length === 0 && (
        <div className={s.empty}>No caregivers on the active roster.</div>
      )}

      {!loading && eligible.length === 0 && filtered.length > 0 && (
        <div className={s.empty}>
          No eligible caregivers for this shift. See filtered section below to override.
        </div>
      )}

      {/* ─── Eligible list ─── */}
      {eligible.length > 0 && (
        <ul className={s.list}>
          {eligible.map((entry) => (
            <PickerRow
              key={entry.caregiver.id}
              entry={entry}
              selected={entry.caregiver.id === value}
              onPick={() => handlePick(entry.caregiver.id)}
            />
          ))}
        </ul>
      )}

      {/* ─── Filtered out, collapsible ─── */}
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
                <PickerRow
                  key={entry.caregiver.id}
                  entry={entry}
                  selected={entry.caregiver.id === value}
                  onPick={() => handlePick(entry.caregiver.id)}
                  filtered
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Picker row ────────────────────────────────────────────────

function PickerRow({ entry, selected, onPick, filtered }) {
  const { caregiver, filterDetail } = entry;
  const displayName =
    `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim() || caregiver.id;
  const reason = filtered ? filterDetail : formatEligibleReason(entry);

  return (
    <li className={`${s.row} ${selected ? s.rowSelected : ''} ${filtered ? s.rowFiltered : ''}`}>
      <button type="button" className={s.rowBtn} onClick={onPick}>
        <span className={s.radio} aria-hidden>
          {selected ? '●' : '○'}
        </span>
        <span className={s.rowText}>
          <span className={s.rowName}>{displayName}</span>
          <span className={s.rowReason}>{reason}</span>
        </span>
        {filtered && (
          <span className={s.warningBadge} title="Override warning">!</span>
        )}
      </button>
    </li>
  );
}
