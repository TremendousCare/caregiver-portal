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
  getCarePlansForClient,
} from './storage';
import {
  computeDefaultShiftEnd,
  shiftToCalendarEvent,
} from './shiftHelpers';
import {
  weekBoundsContainingLocal,
  sumShiftHoursInWindow,
  countShiftsByStatus,
  sumActivePlanHours,
  formatScheduledVsPlanned,
} from './scheduleViewHelpers';
import { ShiftCreateModal } from './ShiftCreateModal';
import { ShiftDrawer } from './ShiftDrawer';
import s from './CaregiverSchedulePanel.module.css';

// ═══════════════════════════════════════════════════════════════
// ClientSchedulePanel — Phase 6
//
// The "Schedule" section on a client's detail page. Mirrors the
// caregiver side but filtered to this client's shifts, with
// gap detection against their active care plan target hours.
//
// No availability shading (that's caregiver-specific). Shift
// blocks show the assigned caregiver's name, and the header
// counter compares scheduled hours against planned hours.
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

export function ClientSchedulePanel({ client, showToast }) {
  const calendarRef = useRef(null);
  const { currentUserName, currentUserEmail } = useApp();
  const { activeClients } = useClients();
  const { rosterCaregivers } = useCaregivers();

  const [currentView, setCurrentView] = useState('timeGridWeek');
  const [visibleRange, setVisibleRange] = useState(null);

  const [shifts, setShifts] = useState([]);
  const [carePlans, setCarePlans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const [createDraft, setCreateDraft] = useState(null);
  const [selectedShift, setSelectedShift] = useState(null);

  // ─── Look-up maps for the drawer/modal props ────────────────
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

  // ─── Load this client's shifts for the visible range ───────
  const loadShifts = useCallback(async () => {
    if (!visibleRange || !client?.id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await getShifts({
        clientId: client.id,
        startDate: visibleRange.start.toISOString(),
        endDate: visibleRange.end.toISOString(),
      });
      setShifts(rows);
    } catch (e) {
      console.error('Client schedule load failed:', e);
      setLoadError(e.message || 'Failed to load shifts');
    } finally {
      setLoading(false);
    }
  }, [visibleRange, client?.id]);

  useEffect(() => {
    loadShifts();
  }, [loadShifts]);

  // ─── Load care plans for this client (for gap detection) ───
  const loadCarePlans = useCallback(async () => {
    if (!client?.id) return;
    try {
      const plans = await getCarePlansForClient(client.id);
      setCarePlans(plans);
    } catch (e) {
      console.error('Load care plans failed:', e);
    }
  }, [client?.id]);

  useEffect(() => {
    loadCarePlans();
  }, [loadCarePlans]);

  // ─── Realtime: watch shifts and care plans for this client ─
  useEffect(() => {
    if (!supabase || !client?.id) return undefined;
    const channel = supabase
      .channel(`client-schedule-${client.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'shifts',
          filter: `client_id=eq.${client.id}`,
        },
        () => loadShifts(),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'care_plans',
          filter: `client_id=eq.${client.id}`,
        },
        () => loadCarePlans(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [client?.id, loadShifts, loadCarePlans]);

  // ─── Calendar events ────────────────────────────────────────
  const calendarEvents = useMemo(() => {
    return shifts
      .map((shift) => shiftToCalendarEvent(shift, { clientsById, caregiversById }))
      .filter(Boolean);
  }, [shifts, clientsById, caregiversById]);

  // ─── Hours stats + gap detection ────────────────────────────
  const weekStats = useMemo(() => {
    if (!visibleRange) {
      return { scheduled: 0, planned: 0, counts: countShiftsByStatus([]) };
    }
    const bounds = weekBoundsContainingLocal(visibleRange.start) ||
      { start: visibleRange.start, end: visibleRange.end };
    const scheduled = sumShiftHoursInWindow(shifts, bounds.start, bounds.end);
    const planned = sumActivePlanHours(carePlans);
    const counts = countShiftsByStatus(
      shifts.filter((sh) => {
        if (!sh.startTime) return false;
        const t = new Date(sh.startTime).getTime();
        return t >= bounds.start.getTime() && t <= bounds.end.getTime();
      }),
    );
    return { scheduled, planned, counts };
  }, [shifts, carePlans, visibleRange]);

  const statusSummary = useMemo(() => {
    const parts = [];
    if (weekStats.counts.confirmed > 0) parts.push(`${weekStats.counts.confirmed} confirmed`);
    if (weekStats.counts.assigned > 0) parts.push(`${weekStats.counts.assigned} assigned`);
    if (weekStats.counts.open > 0) parts.push(`${weekStats.counts.open} open`);
    if (weekStats.counts.offered > 0) parts.push(`${weekStats.counts.offered} offered`);
    return parts.join(' · ');
  }, [weekStats]);

  // ─── Calendar handlers ──────────────────────────────────────
  const handleDatesSet = (info) => {
    setVisibleRange({ start: info.start, end: info.end });
  };

  const handleEventClick = (info) => {
    const shift = info.event.extendedProps?.shift;
    if (!shift) return;
    setSelectedShift(shift);
  };

  const openCreateWithSlot = (start, end) => {
    setCreateDraft({
      ...EMPTY_DRAFT_BASE,
      clientId: client.id, // Pre-fill the current client
      // Auto-fill location from the client's address
      locationAddress:
        [client.address, client.city, client.state, client.zip].filter(Boolean).join(', '),
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

  // ─── Close handlers ─────────────────────────────────────────
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

  const clientFirstName = client?.firstName || 'client';

  return (
    <section className={s.panel}>
      <header className={s.header}>
        <div className={s.headerLeft}>
          <h3 className={s.title}>Schedule</h3>
          <p className={s.subtitle}>
            {formatScheduledVsPlanned(weekStats.scheduled, weekStats.planned)} this week
            {statusSummary && ` · ${statusSummary}`}
          </p>
        </div>
        <div className={s.headerRight}>
          <button className={s.primaryBtn} onClick={handleNewShift}>
            + New shift for {clientFirstName}
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
          carePlans={carePlans}
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
          carePlans={carePlans}
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
