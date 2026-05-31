import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { useApp } from '../../shared/context/AppContext';
import { useClients } from '../../shared/context/ClientContext';
import { useCaregivers } from '../../shared/context/CaregiverContext';
import { supabase } from '../../lib/supabase';
import {
  getShifts,
  updateShift,
  getServicePlansForClient,
  getClockEventsSummaryForShifts,
} from './storage';
import {
  SHIFT_STATUSES,
  computeDefaultShiftEnd,
  isShiftHiddenFromCalendar,
  shiftStatusLabel,
  shiftToCalendarEvent,
} from './shiftHelpers';
import { ResourceLaneView } from './ResourceLaneView';
import { computeDayWindowMs } from './resourceLaneHelpers';
import { DEFAULT_APP_TIMEZONE } from '../../lib/scheduling/timezone';
import { ShiftCreateModal } from './ShiftCreateModal';
import { ShiftDrawer } from './ShiftDrawer';
import { BroadcastModal } from './BroadcastModal';
import { SearchableSelect } from '../../shared/components/SearchableSelect';
import { sortClientsByName, clientDisplayName } from '../../lib/clientSort';
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
  servicePlanId: null,
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
  const { rosterCaregivers, onboardingCaregivers } = useCaregivers();

  const [currentView, setCurrentView] = useState('timeGridWeek');
  const [visibleRange, setVisibleRange] = useState(null);

  // Board mode: the FullCalendar grid ('calendar') or the resource-lane
  // board ('lanes'). The lane board manages its own single-day window and
  // row entity, but shares the data load, filters, and drawer with the grid.
  // Defaults to 'lanes' — the resource-lane board is the preferred landing
  // view when any user enters the calendar.
  const [boardMode, setBoardMode] = useState('lanes');
  const [laneDate, setLaneDate] = useState(() => new Date());
  const [laneRowMode, setLaneRowMode] = useState('caregiver'); // 'caregiver' | 'client'

  // Filters
  const [filterClient, setFilterClient] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Data
  const [shifts, setShifts] = useState([]);
  const [actualsByShiftId, setActualsByShiftId] = useState(() => new Map());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Service plans cached per client as users interact. Avoids pulling
  // every plan up front.
  const [servicePlansByClient, setServicePlansByClient] = useState({});

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

  const clientFilterOptions = useMemo(
    () =>
      sortClientsByName(activeClients).map((c) => ({
        value: c.id,
        label: clientDisplayName(c),
      })),
    [activeClients],
  );

  // Caregivers that can be assigned to a shift: full active roster plus
  // applicants still in onboarding. Onboarding caregivers are flagged
  // visually in the picker so schedulers know they're not fully cleared,
  // but they can still be assigned so we can fill shifts we're actively
  // hiring for.
  const schedulableCaregivers = useMemo(
    () => [...(rosterCaregivers || []), ...(onboardingCaregivers || [])],
    [rosterCaregivers, onboardingCaregivers],
  );

  const caregiversById = useMemo(() => {
    const map = {};
    for (const c of schedulableCaregivers) map[c.id] = c;
    return map;
  }, [schedulableCaregivers]);

  // All service plans, flattened, used by the form to list plans for
  // the currently selected client.
  const allServicePlans = useMemo(() => {
    const list = [];
    for (const plans of Object.values(servicePlansByClient)) {
      for (const p of plans) list.push(p);
    }
    return list;
  }, [servicePlansByClient]);

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

      // Bulk-load actuals for the visible shifts so the calendar
      // can flag variance (late start, overtime, undertime) without
      // a per-shift round-trip. Best-effort — if it fails, calendar
      // still renders without variance chips.
      const shiftIds = rows.map((r) => r.id);
      try {
        const summary = await getClockEventsSummaryForShifts(shiftIds);
        setActualsByShiftId(summary);
      } catch (e) {
        console.warn('Failed to load shift actuals summary:', e);
        setActualsByShiftId(new Map());
      }
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

  // In lane mode FullCalendar is unmounted, so it can't drive the visible
  // range via datesSet. Derive the window from the selected lane day (the
  // full agency-local day) so the shared loadShifts pipeline fetches it.
  useEffect(() => {
    if (boardMode !== 'lanes') return;
    const { startMs, endMs } = computeDayWindowMs({
      date: laneDate,
      startHour: 0,
      endHour: 24,
      timezone: DEFAULT_APP_TIMEZONE,
    });
    setVisibleRange({ start: new Date(startMs), end: new Date(endMs) });
  }, [boardMode, laneDate]);

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

  // ─── Load service plans for a client (lazy) ─────────────────────
  const ensureServicePlansForClient = useCallback(
    async (clientId) => {
      if (!clientId) return;
      if (servicePlansByClient[clientId]) return;
      try {
        const plans = await getServicePlansForClient(clientId);
        setServicePlansByClient((prev) => ({ ...prev, [clientId]: plans }));
      } catch (e) {
        console.error('Failed to load service plans for client:', e);
      }
    },
    [servicePlansByClient],
  );

  // ─── FullCalendar events ─────────────────────────────────────
  // Shift objects that should be visible given the active status filter.
  // Shared by both the FullCalendar grid (mapped to events below) and the
  // resource-lane board (which consumes shift objects directly).
  const visibleShifts = useMemo(
    () => shifts.filter((shift) => !isShiftHiddenFromCalendar(shift, filterStatus || null)),
    [shifts, filterStatus],
  );

  const calendarEvents = useMemo(() => {
    return visibleShifts
      .map((shift) =>
        shiftToCalendarEvent(shift, {
          clientsById,
          caregiversById,
          actuals: actualsByShiftId.get(shift.id) || null,
        }),
      )
      .filter(Boolean);
  }, [visibleShifts, clientsById, caregiversById, actualsByShiftId]);

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
    ensureServicePlansForClient(shift.clientId);
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
    const wasLanes = boardMode === 'lanes';
    setBoardMode('calendar');
    setCurrentView(viewName);
    // When leaving the lane board FullCalendar remounts with
    // initialView={currentView}; only the already-mounted grid needs an
    // imperative changeView.
    if (!wasLanes) calendarRef.current?.getApi()?.changeView(viewName);
  };

  const showLaneBoard = () => setBoardMode('lanes');

  // ─── Lane board day navigation ───────────────────────────────
  const shiftLaneDate = (deltaDays) =>
    setLaneDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + deltaDays);
      return next;
    });

  const laneDateLabel = laneDate.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: DEFAULT_APP_TIMEZONE,
  });

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

  // When the selected client in the create modal changes, preload its service plans
  useEffect(() => {
    if (createDraft?.clientId) ensureServicePlansForClient(createDraft.clientId);
  }, [createDraft?.clientId, ensureServicePlansForClient]);

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
              aria-selected={boardMode === 'calendar' && currentView === 'timeGridDay'}
              className={`${s.viewBtn} ${boardMode === 'calendar' && currentView === 'timeGridDay' ? s.viewBtnActive : ''}`}
              onClick={() => handleViewChange('timeGridDay')}
            >
              Day
            </button>
            <button
              role="tab"
              aria-selected={boardMode === 'calendar' && currentView === 'timeGridWeek'}
              className={`${s.viewBtn} ${boardMode === 'calendar' && currentView === 'timeGridWeek' ? s.viewBtnActive : ''}`}
              onClick={() => handleViewChange('timeGridWeek')}
            >
              Week
            </button>
            <button
              role="tab"
              aria-selected={boardMode === 'calendar' && currentView === 'dayGridMonth'}
              className={`${s.viewBtn} ${boardMode === 'calendar' && currentView === 'dayGridMonth' ? s.viewBtnActive : ''}`}
              onClick={() => handleViewChange('dayGridMonth')}
            >
              Month
            </button>
            <button
              role="tab"
              aria-selected={boardMode === 'lanes'}
              className={`${s.viewBtn} ${boardMode === 'lanes' ? s.viewBtnActive : ''}`}
              onClick={showLaneBoard}
            >
              Lanes
            </button>
          </div>
        </div>
      </header>

      <div className={s.filtersBar}>
        <div className={s.filterLabel}>
          <span id="schedule-client-filter-label">Client</span>
          <SearchableSelect
            value={filterClient}
            onChange={setFilterClient}
            options={clientFilterOptions}
            emptyOption={{ value: '', label: 'All clients' }}
            placeholder="Search clients…"
            ariaLabel="Filter by client"
          />
        </div>
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
          {loading
            ? 'Loading…'
            : `${calendarEvents.length} shift${calendarEvents.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {loadError && <div className={s.errorBanner}>Error: {loadError}</div>}

      {boardMode === 'lanes' ? (
        <>
          <div className={s.laneToolbar}>
            <div className={s.laneNav}>
              <button
                className={s.laneNavBtn}
                onClick={() => shiftLaneDate(-1)}
                aria-label="Previous day"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                className={s.laneNavBtn}
                onClick={() => shiftLaneDate(1)}
                aria-label="Next day"
              >
                <ChevronRight size={16} />
              </button>
              <button className={s.laneTodayBtn} onClick={() => setLaneDate(new Date())}>
                Today
              </button>
              <span className={s.laneDateLabel}>{laneDateLabel}</span>
            </div>
            <div className={s.viewToggle} role="tablist" aria-label="Lane grouping">
              <button
                role="tab"
                aria-selected={laneRowMode === 'caregiver'}
                className={`${s.viewBtn} ${laneRowMode === 'caregiver' ? s.viewBtnActive : ''}`}
                onClick={() => setLaneRowMode('caregiver')}
              >
                By caregiver
              </button>
              <button
                role="tab"
                aria-selected={laneRowMode === 'client'}
                className={`${s.viewBtn} ${laneRowMode === 'client' ? s.viewBtnActive : ''}`}
                onClick={() => setLaneRowMode('client')}
              >
                By client
              </button>
            </div>
          </div>
          <div className={s.calendarWrap}>
            <ResourceLaneView
              date={laneDate}
              mode={laneRowMode}
              shifts={visibleShifts}
              caregivers={schedulableCaregivers}
              clients={activeClients}
              clientsById={clientsById}
              caregiversById={caregiversById}
              onShiftClick={(shift) => {
                setSelectedShift(shift);
                ensureServicePlansForClient(shift.clientId);
              }}
            />
          </div>
        </>
      ) : (
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
            height="100%"
            allDaySlot={false}
            slotDuration="01:00:00"
            snapDuration="00:15:00"
            slotLabelInterval="01:00"
            slotMinTime="00:00:00"
            slotMaxTime="24:00:00"
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
      )}

      {createDraft && (
        <ShiftCreateModal
          initialDraft={createDraft}
          clients={activeClients}
          caregivers={schedulableCaregivers}
          servicePlans={allServicePlans}
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
          caregivers={schedulableCaregivers}
          servicePlans={allServicePlans}
          currentUserName={currentUserName}
          currentUserEmail={currentUserEmail}
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
          caregivers={schedulableCaregivers}
          client={clientsById[broadcastShift.clientId] || null}
          currentUserName={currentUserName}
          currentUserEmail={currentUserEmail}
          onClose={() => setBroadcastShift(null)}
          onBroadcastSent={(result) => {
            // Refresh shifts either way so the drawer reflects any
            // partial writes. Only auto-close on full success.
            loadShifts();
            if (!result?.keepOpen) {
              setBroadcastShift(null);
            }
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}
