import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { UploadCloud, CloudOff } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import {
  shiftCache,
  clockOutbox,
  onOutboxChanged,
  isOnline,
} from '../../lib/offline/clockSyncClient';
import { effectiveShiftStatus } from '../../lib/offline/pendingStatus';
import { usePendingClockCount } from './hooks/useClockSync';
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
  return `${timeFmt.format(start)} – ${timeFmt.format(end)}`;
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
  const [pendingByShift, setPendingByShift] = useState({});
  const [usingCache, setUsingCache] = useState(false);
  const [error, setError] = useState(null);
  const pendingCount = usePendingClockCount();

  const refreshPending = useCallback(async () => {
    try {
      const all = await clockOutbox.list();
      const grouped = {};
      for (const e of all) {
        if (e.status === 'failed') continue;
        (grouped[e.shiftId] = grouped[e.shiftId] || []).push(e);
      }
      setPendingByShift(grouped);
    } catch {
      setPendingByShift({});
    }
  }, []);

  const load = useCallback(async () => {
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

    if (err) {
      // Offline (or query failed): fall back to whatever we cached on a
      // previous online load so the caregiver can still see their day.
      const cached = await shiftCache.getShifts();
      if (cached.length > 0) {
        const withClients = await Promise.all(
          cached.map(async (sh) => ({ ...sh, client: await shiftCache.getClient(sh.client_id) })),
        );
        setShifts(withClients);
        setUsingCache(true);
      } else {
        setError(err.message);
      }
      await refreshPending();
      return;
    }

    setUsingCache(false);

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
      shiftCache.putClients(clients || []);
    }

    shiftCache.putShifts(data || []);
    setShifts((data || []).map((sh) => ({ ...sh, client: clientsById[sh.client_id] || null })));
    await refreshPending();
  }, [caregiver.id, refreshPending]);

  useEffect(() => {
    let cancelled = false;
    load().catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [load]);

  // Reload when the outbox changes (something synced) to refresh statuses.
  useEffect(() => onOutboxChanged(() => { load(); }), [load]);

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
          onClick={async () => {
            try {
              await supabase.auth.signOut();
            } catch (e) {
              console.error('Sign out failed:', e);
            }
            window.location.reload();
          }}
        >
          Sign out
        </button>
      </header>

      {pendingCount > 0 && (
        <div className={s.syncBadge} role="status">
          <UploadCloud size={14} aria-hidden="true" />
          <span>
            {pendingCount} clock {pendingCount === 1 ? 'event' : 'events'} waiting to sync
            {isOnline() ? '…' : ' — will sync when you reconnect.'}
          </span>
        </div>
      )}

      {usingCache && (
        <div className={s.cacheNotice} role="status">
          <CloudOff size={14} aria-hidden="true" />
          <span>Showing saved shifts — you appear to be offline.</span>
        </div>
      )}

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
            const pending = pendingByShift[sh.id] || [];
            const status = effectiveShiftStatus(sh.status, pending);
            return (
              <li key={sh.id}>
                <Link className={s.shiftCard} to={`/care/shifts/${sh.id}`}>
                  <div className={s.shiftDay}>{formatShiftDay(sh.start_time)}</div>
                  <div className={s.shiftTime}>{formatShiftWindow(sh.start_time, sh.end_time)}</div>
                  <div className={s.shiftClient}>{clientName}</div>
                  <div className={s.shiftStatus}>
                    {STATUS_LABEL[status] || status}
                    {pending.length > 0 && <span className={s.pendingTag}>Sync</span>}
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
