import { useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { useApp } from '../../shared/context/AppContext';
import layout from '../../styles/layout.module.css';
import s from './SchedulePage.module.css';

// ─── Scheduling — Phase 0 Scaffold ───
// This is the placeholder landing page for the /schedule route.
// Phase 0 goal: prove the calendar library renders cleanly on a new route
// without touching the database, existing pages, or business logic.
//
// Future phases will replace this with:
//   - Real shifts loaded from the `shifts` table (Phase 1+2)
//   - Click-to-create shift modal (Phase 4)
//   - Drag-and-drop reassignment (Phase 4)
//   - Status-based color coding (Phase 4)
//   - Shift drawer with broadcast workflow (Phase 5)
//
// The data model and plan are documented in the Scheduling Feature Plan.

export function SchedulePage() {
  const { sidebarCollapsed } = useApp();
  const calendarRef = useRef(null);
  const [currentView, setCurrentView] = useState('timeGridWeek');

  // Phase 0: no events yet. The calendar renders empty with a helpful message.
  const events = [];

  const handleViewChange = (viewName) => {
    setCurrentView(viewName);
    const api = calendarRef.current?.getApi();
    if (api) api.changeView(viewName);
  };

  return (
    <div
      className={s.page}
      style={{ marginLeft: sidebarCollapsed ? 64 : 0 }}
    >
      <header className={s.header}>
        <div>
          <h1 className={s.title}>Schedule</h1>
          <p className={s.subtitle}>
            Calendar view of shifts, availability, and caregiver assignments
          </p>
        </div>
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
      </header>

      <div className={s.scaffoldBanner} role="status">
        <strong>Phase 0 scaffold</strong> — scheduling infrastructure is being built in
        phases. This calendar is live but not yet connected to data. Shifts, availability,
        and broadcast workflows will appear in upcoming releases.
      </div>

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
          slotDuration="00:15:00"
          slotLabelInterval="01:00"
          slotMinTime="05:00:00"
          slotMaxTime="23:00:00"
          nowIndicator
          firstDay={0}
          expandRows
          stickyHeaderDates
          events={events}
          eventColor="#2E4E8D"
          dayMaxEvents
        />
      </div>
    </div>
  );
}
