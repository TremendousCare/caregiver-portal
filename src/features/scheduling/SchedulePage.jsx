import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { useApp } from '../../shared/context/AppContext';
import { useClients } from '../../shared/context/ClientContext';
import { useCaregivers } from '../../shared/context/CaregiverContext';
import { supabase } from '../../lib/supabase';
import { getShifts, updateShift, getCarePlansForClient } from './storage';
import {
  SHIFT_STATUSES,
  computeDefaultShiftEnd,
  shiftStatusLabel,
  shiftToCalendarEvent,
} from './shiftHelpers';
import { ShiftCreateModal } from './ShiftCreateModal';
import { ShiftDrawer } from './ShiftDrawer';
import { BroadcastModal } from './BroadcastModal';
import s from './SchedulePage.module.css';

// ═══════════════════════════════════════════════════════════════
// SchedulePage — Phase 4b
//
// The master calendar. Replaces the Phase 0 placeholder with a
// FullCalendar view wired to the `shifts` table. Supports:
//   - Day / Week / Month views
//   - Status + client filters
//   - Click empty slot → ShiftCreateModal
//   - Click shift → ShiftDrawer
//   - Drag to move in time
//   - Drag edge to resize duration
//   - Realtime subscription so the calendar stays in sync
//
// Smart caregiver matching (availability-based eligibility and
// conflict detection in the assignment UI) comes in Phase 4c.
// ═══════════════════════════════════════════════════════════════

const EMPTY_DRAFT_BASE = {
  clientId: '',
  carePlanId: null,
  assignedCaregiverId: null,
  startTime: null,
  endTime: null,
  locationAddress: '',
  hourlyRate: null,
  billableRate: null,
  mileage: null,
  requiredSkills: [],
  instructions: '',
  notes: '',
};

export function SchedulePage() {
  const calendarRef = useRef(null);
  const { showToast, currentUserName, currentUserEmail } = useApp();
  const { activeClients } = useClients();
  const { rosterCaregivers } = useCaregivers();

  const [currentView, setCurrentView] = useState('timeGridWeek');
  const [visibleRange, setVisibleRange] = useState(null);

  // Filters
  const [filterClient, setFilterClient] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Data
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Care plans cached per client as users interact. Avoids pulling
  // every plan up front.
  const [carePlansByClient, setCarePlansByClient] = useState({});

  // Modal / drawer state
  const [createDraft, setCreateDraft] = useState(null); // null = closed
  const [selectedShift, setSelectedShift] = useState(null);
  const [broadcastShift, setBroadcastShift] = useState(null);

  // Precompute lookup maps
  const clientsById = useMemo(() => {
    const map = {};
    for (const c of activeClients || []) map[c.id] = c;
    return map;
  }, [activeClients]);

  const caregiversById = useMemo(() => {
    const map = {};
    for (const c of rosterCaregivers || []) map[c.id] = c;
    return map;
  }, [rosterCaregivers]);

  // All care plans, flattened, used by the form to list plans for
  // the currently selected client.
  const allCarePlans = useMemo(() => {
    const list = [];
    for (const plans of Object.values(carePlansByClient)) {
      for (const p of plans) list.push(p);
    }
    return list;
  }, [carePlansByClient]);

  // ─── Load shifts for the visible range + filters ────────────
  const loadShifts = useCallback(async () => {
    if (!visibleRange) return;
    setLoading(true);
    setLoadError(null);
    try {
      const filters = {
        startDate: visibleRange.start.toISOString(),
        endDate: visibleRange.end.toISOString(),
      };
      if (filterClient) filters.clientId = filterClient;
      if (filterStatus) filters.status = filterStatus;
      const rows = await getShifts(filters);
      setShifts(rows);
    } catch (e) {
      console.error('Failed to load shifts:', e);
      setLoadError(e.message || 'Failed to load shifts');
    } finally {
      setLoading(false);
    }
  }, [visibleRange, filterClient, filterStatus]);

  useEffect(() => {
    loadShifts();
  }, [loadShifts]);

  // ─── Realtime subscription ────────────────────────────────────
  useEffect(() => {
    if (!supabase) return undefined;
    const channel = supabase
      .channel('schedule-shifts')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shifts' },
        () => {
          loadShifts();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadShifts]);

  // ─── Load care plans for a client (lazy) ─────────────────────
  const ensureCarePlansForClient = useCallback(
    async (clientId) => {
      if (!clientId) return;
      if (carePlansByClient[clientId]) return;
      try {
        const plans = await getCarePlansForClient(clientId);
        setCarePlansByClient((prev) => ({ ...prev, [clientId]: plans }));
      } catch (e) {
        console.error('Failed to load care plans for client:', e);
      }
    },
    [carePlansByClient],
  );

  // ─── FullCalendar events ─────────────────────────────────────
  const calendarEvents = useMemo(() => {
    return shifts
      .map((shift) => shiftToCalendarEvent(shift, { clientsById, caregiversById }))
      .filter(Boolean);
  }, [shifts, clientsById, caregiversById]);

  // ─── Calendar handlers ───────────────────────────────────────
  const handleDatesSet = (info) => {
    setVisibleRange({ start: info.start, end: info.end });
  };

  const openCreateWithSlot = useCallback(
    (start, end) => {
      setCreateDraft({
        ...EMPTY_DRAFT_BASE,
        clientId: filterClient || '',
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      });
    },
    [filterClient],
  );

  const handleSelect = (info) => {
    const startMs = info.start.getTime();
    let endMs = info.end.getTime();
    const durationMs = endMs - startMs;
    if (durationMs < 60 * 60 * 1000) {
      // Less than 1 hour → click-to-create, apply default 4hr
      endMs = computeDefaultShiftEnd(info.start).getTime();
    }
    openCreateWithSlot(new Date(startMs), new Date(endMs));
    calendarRef.current?.getApi()?.unselect();
  };

  const handleDateClick = (info) => {
    // Fires for single clicks in month view
    const start = info.date;
    const end = computeDefaultShiftEnd(start);
    openCreateWithSlot(start, end);
  };

  const handleEventClick = (info) => {
    const shift = info.event.extendedProps?.shift;
    if (!shift) return;
    setSelectedShift(shift);
    ensureCarePlansForClient(shift.clientId);
  };

  const handleEventDrop = async (info) => {
    const shift = info.event.extendedProps?.shift;
    if (!shift) return;
    try {
      await updateShift(shift.id, {
        startTime: info.event.start.toISOString(),
        endTime: info.event.end.toISOString(),
      });
      showToast?.('Shift moved');
      loadShifts();
    } catch (e) {
      console.error('Move failed:', e);
      showToast?.(`Move failed: ${e.message || e}`);
      info.revert();
    }
  };

  const handleEventResize = async (info) => {
    const shift = info.event.extendedProps?.shift;
    if (!shift) return;
    try {
      await updateShift(shift.id, {
        startTime: info.event.start.toISOString(),
        endTime: info.event.end.toISOString(),
      });
      showToast?.('Shift resized');
      loadShifts();
    } catch (e) {
      console.error('Resize failed:', e);
      showToast?.(`Resize failed: ${e.message || e}`);
      info.revert();
    }
  };

  // ─── View toggle ─────────────────────────────────────────────
  const handleViewChange = (viewName) => {
    setCurrentView(viewName);
    calendarRef.current?.getApi()?.changeView(viewName);
  };

  // ─── New shift button (opens create with defaults for "next hour") ──
  const handleNewShift = () => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    openCreateWithSlot(start, computeDefaultShiftEnd(start));
  };

  // ─── Modal / drawer close + refresh ──────────────────────────
  const handleCreateClosed = () => setCreateDraft(null);

  const handleCreated = () => {
    setCreateDraft(null);
    loadShifts();
  };

  const handleDrawerClose = () => setSelectedShift(null);

  const handleDrawerSaved = () => {
    setSelectedShift(null);
    loadShifts();
  };

  const handleDrawerCancelled = () => {
    setSelectedShift(null);
    loadShifts();
  };

  // When the selected client in the create modal changes, preload its care plans
  useEffect(() => {
    if (createDraft?.clientId) ensureCarePlansForClient(createDraft.clientId);
  }, [createDraft?.clientId, ensureCarePlansForClient]);

  // ─── Render ──────────────────────────────────────────────────
  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <h1 className={s.title}>Schedule</h1>
          <p className={s.subtitle}>
            Calendar view of shifts, availability, and caregiver assignments
          </p>
        </div>
        <div className={s.headerActions}>
          <button className={s.primaryBtn} onClick={handleNewShift}>
            + New shift
          </button>
          <div className={s.viewToggle} role="tablist" aria-label="Calendar view">
            <button
              role="tab"
              aria-selected={currentView === 'timeGridDay'}
              className={`${s.viewBtn} ${currentView === 'timeGridDay' ? s.viewBtnActive : ''}`}
              onClick={() => handleViewChange('timeGridDay')}
            >
              Day
            </button>
            <button
              role="tab"
              aria-selected={currentView === 'timeGridWeek'}
              className={`${s.viewBtn} ${currentView === 'timeGridWeek' ? s.viewBtnActive : ''}`}
              onClick={() => handleViewChange('timeGridWeek')}
            >
              Week
            </button>
            <button
              role="tab"
              aria-selected={currentView === 'dayGridMonth'}
              className={`${s.viewBtn} ${currentView === 'dayGridMonth' ? s.viewBtnActive : ''}`}
              onClick={() => handleViewChange('dayGridMonth')}
            >
              Month
            </button>
          </div>
        </div>
      </header>

      <div className={s.filtersBar}>
        <label className={s.filterLabel}>
          Client
          <select
            className={s.filterInput}
            value={filterClient}
            onChange={(e) => setFilterClient(e.target.value)}
          >
            <option value="">All clients</option>
            {(activeClients || []).map((c) => (
              <option key={c.id} value={c.id}>
                {`${c.firstName || ''} ${c.lastName || ''}`.trim() || c.id}
              </option>
            ))}
          </select>
        </label>
        <label className={s.filterLabel}>
          Status
          <select
            className={s.filterInput}
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {SHIFT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {shiftStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <div className={s.filterSummary}>
          {loading ? 'Loading…' : `${shifts.length} shift${shifts.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {loadError && <div className={s.errorBanner}>Error: {loadError}</div>}

      <div className={s.calendarWrap}>
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView={currentView}
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: '',
          }}
          height="auto"
          allDaySlot={false}
          slotDuration="00:15:00"
          slotLabelInterval="01:00"
          slotMinTime="05:00:00"
          slotMaxTime="23:00:00"
          nowIndicator
          firstDay={0}
          stickyHeaderDates
          events={calendarEvents}
          selectable
          selectMirror
          editable
          eventStartEditable
          eventDurationEditable
          eventOverlap
          dayMaxEvents
          datesSet={handleDatesSet}
          select={handleSelect}
          dateClick={handleDateClick}
          eventClick={handleEventClick}
          eventDrop={handleEventDrop}
          eventResize={handleEventResize}
        />
      </div>

      {createDraft && (
        <ShiftCreateModal
          initialDraft={createDraft}
          clients={activeClients}
          caregivers={rosterCaregivers}
          carePlans={allCarePlans}
          currentUserName={currentUserName}
          onClose={handleCreateClosed}
          onCreated={handleCreated}
          showToast={showToast}
        />
      )}

      {selectedShift && (
        <ShiftDrawer
          shift={selectedShift}
          clients={activeClients}
          caregivers={rosterCaregivers}
          carePlans={allCarePlans}
          currentUserName={currentUserName}
          onClose={handleDrawerClose}
          onSaved={handleDrawerSaved}
          onCancelled={handleDrawerCancelled}
          onBroadcast={(shift) => setBroadcastShift(shift)}
          showToast={showToast}
        />
      )}

      {broadcastShift && (
        <BroadcastModal
          shift={broadcastShift}
          caregivers={rosterCaregivers}
          client={clientsById[broadcastShift.clientId] || null}
          currentUserName={currentUserName}
          currentUserEmail={currentUserEmail}
          onClose={() => setBroadcastShift(null)}
          onBroadcastSent={() => {
            setBroadcastShift(null);
            loadShifts();
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}
