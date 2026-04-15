import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  getAvailability,
  getCarePlansForClient,
} from './storage';
import {
  computeDefaultShiftEnd,
  shiftToCalendarEvent,
} from './shiftHelpers';
import {
  buildRecurringAvailabilityEvents,
  buildOneOffBackgroundEvents,
  weekBoundsContainingLocal,
  sumShiftHoursInWindow,
  countShiftsByStatus,
  formatScheduledVsPlanned,
} from './scheduleViewHelpers';
import { ShiftCreateModal } from './ShiftCreateModal';
import { ShiftDrawer } from './ShiftDrawer';
import s from './CaregiverSchedulePanel.module.css';

// ═══════════════════════════════════════════════════════════════
// CaregiverSchedulePanel — Phase 6
//
// The "Schedule" tab on a caregiver's detail page. Shows a week
// calendar filtered to only this caregiver's assigned shifts,
// with their structured availability painted as background
// shading (green for available, red for time-off blocks).
//
// Includes a hours-this-week counter, a "+ New shift" shortcut
// that pre-fills this caregiver in the create modal, and uses
// the same ShiftDrawer as the master calendar when a shift is
// clicked.
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

export function CaregiverSchedulePanel({ caregiver, showToast }) {
  const calendarRef = useRef(null);
  const { currentUserName, currentUserEmail } = useApp();
  const { activeClients } = useClients();
  const { rosterCaregivers } = useCaregivers();

  const [currentView, setCurrentView] = useState('timeGridWeek');
  const [visibleRange, setVisibleRange] = useState(null);

  const [shifts, setShifts] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const [carePlansByClient, setCarePlansByClient] = useState({});
  const [createDraft, setCreateDraft] = useState(null);
  const [selectedShift, setSelectedShift] = useState(null);

  // ─── Look-up maps for the drawer/modal props ─────────────────
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

  const allCarePlans = useMemo(() => {
    const list = [];
    for (const plans of Object.values(carePlansByClient)) {
      for (const p of plans) list.push(p);
    }
    return list;
  }, [carePlansByClient]);

  // ─── Load this caregiver's shifts for the visible range ────
  const loadShifts = useCallback(async () => {
    if (!visibleRange || !caregiver?.id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await getShifts({
        caregiverId: caregiver.id,
        startDate: visibleRange.start.toISOString(),
        endDate: visibleRange.end.toISOString(),
      });
      setShifts(rows);
    } catch (e) {
      console.error('Caregiver schedule load failed:', e);
      setLoadError(e.message || 'Failed to load shifts');
    } finally {
      setLoading(false);
    }
  }, [visibleRange, caregiver?.id]);

  useEffect(() => {
    loadShifts();
  }, [loadShifts]);

  // ─── Load this caregiver's structured availability once ───
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await getAvailability(caregiver.id);
        if (!cancelled) setAvailability(rows);
      } catch (e) {
        console.error('Load availability failed:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caregiver.id]);

  // ─── Realtime: refresh when this caregiver's shifts change ─
  useEffect(() => {
    if (!supabase || !caregiver?.id) return undefined;
    const channel = supabase
      .channel(`caregiver-schedule-${caregiver.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'shifts',
          filter: `assigned_caregiver_id=eq.${caregiver.id}`,
        },
        () => loadShifts(),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'caregiver_availability',
          filter: `caregiver_id=eq.${caregiver.id}`,
        },
        async () => {
          const rows = await getAvailability(caregiver.id);
          setAvailability(rows);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [caregiver.id, loadShifts]);

  // ─── Care plans for the shift form (lazy per client) ────────
  const ensureCarePlansForClient = useCallback(
    async (clientId) => {
      if (!clientId) return;
      if (carePlansByClient[clientId]) return;
      try {
        const plans = await getCarePlansForClient(clientId);
        setCarePlansByClient((prev) => ({ ...prev, [clientId]: plans }));
      } catch (e) {
        console.error('Failed to load care plans:', e);
      }
    },
    [carePlansByClient],
  );

  // ─── Build calendar events: shifts + availability background ─
  const calendarEvents = useMemo(() => {
    const shiftEvents = shifts
      .map((shift) => shiftToCalendarEvent(shift, { clientsById, caregiversById }))
      .filter(Boolean);

    if (!visibleRange) return shiftEvents;

    const recurringBg = buildRecurringAvailabilityEvents(
      availability,
      visibleRange.start,
      visibleRange.end,
    );
    const oneOffBg = buildOneOffBackgroundEvents(
      availability,
      visibleRange.start,
      visibleRange.end,
    );

    return [...recurringBg, ...oneOffBg, ...shiftEvents];
  }, [shifts, clientsById, caregiversById, availability, visibleRange]);

  // ─── Hours this week counter ─────────────────────────────────
  const weekStats = useMemo(() => {
    if (!visibleRange) return { hours: 0, counts: countShiftsByStatus([]) };
    // Use the week containing the current visible range start so the
    // counter always reflects "this week" regardless of which calendar
    // view is active.
    const bounds = weekBoundsContainingLocal(visibleRange.start) ||
      { start: visibleRange.start, end: visibleRange.end };
    const hours = sumShiftHoursInWindow(shifts, bounds.start, bounds.end);
    const counts = countShiftsByStatus(
      shifts.filter((sh) => {
        if (!sh.startTime) return false;
        const t = new Date(sh.startTime).getTime();
        return t >= bounds.start.getTime() && t <= bounds.end.getTime();
      }),
    );
    return { hours, counts };
  }, [shifts, visibleRange]);

  // ─── Calendar interaction handlers ───────────────────────────
  const handleDatesSet = (info) => {
    setVisibleRange({ start: info.start, end: info.end });
  };

  const handleEventClick = (info) => {
    // Ignore clicks on availability background events
    if (info.event.display === 'background') return;
    const shift = info.event.extendedProps?.shift;
    if (!shift) return;
    setSelectedShift(shift);
    ensureCarePlansForClient(shift.clientId);
  };

  const openCreateWithSlot = (start, end) => {
    setCreateDraft({
      ...EMPTY_DRAFT_BASE,
      assignedCaregiverId: caregiver.id, // Pre-fill the current caregiver
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    });
  };

  const handleSelect = (info) => {
    const startMs = info.start.getTime();
    let endMs = info.end.getTime();
    if (endMs - startMs < 60 * 60 * 1000) {
      endMs = computeDefaultShiftEnd(info.start).getTime();
    }
    openCreateWithSlot(new Date(startMs), new Date(endMs));
    calendarRef.current?.getApi()?.unselect();
  };

  const handleDateClick = (info) => {
    const start = info.date;
    const end = computeDefaultShiftEnd(start);
    openCreateWithSlot(start, end);
  };

  const handleNewShift = () => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    openCreateWithSlot(start, computeDefaultShiftEnd(start));
  };

  const handleViewChange = (viewName) => {
    setCurrentView(viewName);
    calendarRef.current?.getApi()?.changeView(viewName);
  };

  // ─── Close handlers ──────────────────────────────────────────
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

  // When the create modal client changes, preload its care plans
  useEffect(() => {
    if (createDraft?.clientId) ensureCarePlansForClient(createDraft.clientId);
  }, [createDraft?.clientId, ensureCarePlansForClient]);

  const caregiverFirstName = caregiver?.firstName || 'caregiver';

  return (
    <section className={s.panel}>
      <header className={s.header}>
        <div className={s.headerLeft}>
          <h3 className={s.title}>Schedule</h3>
          <p className={s.subtitle}>
            {formatScheduledVsPlanned(weekStats.hours, 0)} this week ·{' '}
            {weekStats.counts.confirmed} confirmed · {weekStats.counts.assigned} assigned
            {weekStats.counts.open > 0 && ` · ${weekStats.counts.open} open`}
          </p>
        </div>
        <div className={s.headerRight}>
          <button className={s.primaryBtn} onClick={handleNewShift}>
            + New shift for {caregiverFirstName}
          </button>
          <div className={s.viewToggle}>
            <button
              className={`${s.viewBtn} ${currentView === 'timeGridDay' ? s.viewBtnActive : ''}`}
              onClick={() => handleViewChange('timeGridDay')}
            >
              Day
            </button>
            <button
              className={`${s.viewBtn} ${currentView === 'timeGridWeek' ? s.viewBtnActive : ''}`}
              onClick={() => handleViewChange('timeGridWeek')}
            >
              Week
            </button>
            <button
              className={`${s.viewBtn} ${currentView === 'dayGridMonth' ? s.viewBtnActive : ''}`}
              onClick={() => handleViewChange('dayGridMonth')}
            >
              Month
            </button>
          </div>
        </div>
      </header>

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
          dayMaxEvents
          datesSet={handleDatesSet}
          select={handleSelect}
          dateClick={handleDateClick}
          eventClick={handleEventClick}
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
          currentUserEmail={currentUserEmail}
          onClose={handleDrawerClose}
          onSaved={handleDrawerSaved}
          onCancelled={handleDrawerCancelled}
          showToast={showToast}
        />
      )}
    </section>
  );
}
