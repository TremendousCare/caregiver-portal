import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import s from './CaregiverPortal.module.css';

// Formatters are defined at module scope so we don't re-create them
// on every render.
const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit',
});

function formatShiftWindow(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  return `${timeFmt.format(start)} \u2013 ${timeFmt.format(end)}`;
}

function formatShiftDay(startIso) {
  const start = new Date(startIso);
  const today = new Date();
  const isToday = start.toDateString() === today.toDateString();
  if (isToday) return 'Today';
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (start.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return dayFmt.format(start);
}

// Human-friendly labels for the shift.status values we expect a
// caregiver to encounter. We deliberately skip admin-only statuses
// (offered, cancelled, no_show — those don't render here).
const STATUS_LABEL = {
  assigned: 'Scheduled',
  confirmed: 'Confirmed',
  in_progress: 'Clocked in',
  completed: 'Completed',
};

export function CaregiverShifts({ caregiver }) {
  const [shifts, setShifts] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Show shifts from earlier today through the next two weeks.
      // The caregiver-scoped RLS policy limits rows to their own.
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date();
      to.setDate(to.getDate() + 14);

      const { data, error: err } = await supabase
        .from('shifts')
        .select('id, client_id, start_time, end_time, status, instructions')
        .eq('assigned_caregiver_id', caregiver.id)
        .gte('end_time', from.toISOString())
        .lte('start_time', to.toISOString())
        .order('start_time', { ascending: true });

      if (cancelled) return;
      if (err) { setError(err.message); return; }

      // Batch load the clients referenced by these shifts. RLS
      // `clients_read_assigned` will return only clients tied to the
      // caregiver's shifts/assignments, so this is a safe SELECT.
      const clientIds = Array.from(new Set((data || []).map((sh) => sh.client_id)));
      let clientsById = {};
      if (clientIds.length > 0) {
        const { data: clients } = await supabase
          .from('clients')
          .select('id, first_name, last_name, address, city, state, zip, latitude, longitude, geofence_radius_m')
          .in('id', clientIds);
        clientsById = Object.fromEntries((clients || []).map((c) => [c.id, c]));
      }

      setShifts((data || []).map((sh) => ({ ...sh, client: clientsById[sh.client_id] || null })));
    }
    load();
    return () => { cancelled = true; };
  }, [caregiver.id]);

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <div className={s.muted}>Hi, {caregiver.first_name || 'there'}</div>
          <h1 className={s.pageTitle}>Your shifts</h1>
        </div>
        <button
          type="button"
          className={s.linkBtn}
          onClick={() => supabase.auth.signOut()}
        >
          Sign out
        </button>
      </header>

      {error && <div className={s.error}>{error}</div>}

      {shifts == null && !error && (
        <div className={s.muted}>Loading…</div>
      )}

      {shifts && shifts.length === 0 && (
        <div className={s.emptyCard}>
          <p>No shifts scheduled in the next two weeks.</p>
          <p className={s.muted}>
            If you think this is wrong, contact your coordinator.
          </p>
        </div>
      )}

      {shifts && shifts.length > 0 && (
        <ul className={s.shiftList}>
          {shifts.map((sh) => {
            const clientName = sh.client
              ? `${sh.client.first_name || ''} ${sh.client.last_name || ''}`.trim() || 'Client'
              : 'Client';
            return (
              <li key={sh.id}>
                <Link className={s.shiftCard} to={`/care/shifts/${sh.id}`}>
                  <div className={s.shiftDay}>{formatShiftDay(sh.start_time)}</div>
                  <div className={s.shiftTime}>{formatShiftWindow(sh.start_time, sh.end_time)}</div>
                  <div className={s.shiftClient}>{clientName}</div>
                  <div className={s.shiftStatus}>
                    {STATUS_LABEL[sh.status] || sh.status}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
