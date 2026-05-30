import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CloudOff } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { shiftCache } from '../../lib/offline/clockSyncClient';
import { groupShiftsByDay } from '../../lib/caregiverHistory';
import s from './CaregiverPortal.module.css';

const HISTORY_DAYS = 90;

const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', month: 'short', day: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit',
});

const STATUS_LABEL = {
  completed: 'Completed',
  in_progress: 'Clocked in',
  no_show: 'No show',
  cancelled: 'Cancelled',
  assigned: 'Scheduled',
  confirmed: 'Confirmed',
};

export function CaregiverHistory({ caregiver }) {
  const [shifts, setShifts] = useState(null);
  const [usingCache, setUsingCache] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const now = new Date();
    const from = new Date();
    from.setDate(from.getDate() - HISTORY_DAYS);

    const { data, error: err } = await supabase
      .from('shifts')
      .select('id, client_id, start_time, end_time, status')
      .eq('assigned_caregiver_id', caregiver.id)
      .lt('end_time', now.toISOString())
      .gte('start_time', from.toISOString())
      .order('start_time', { ascending: false });

    if (err) {
      // Offline: show whatever past shifts we cached.
      const cached = (await shiftCache.getShifts()).filter(
        (sh) => Date.parse(sh.end_time) < now.getTime(),
      );
      if (cached.length > 0) {
        const withClients = await Promise.all(
          cached.map(async (sh) => ({ ...sh, client: await shiftCache.getClient(sh.client_id) })),
        );
        setShifts(withClients);
        setUsingCache(true);
      } else {
        setError(err.message);
      }
      return;
    }

    const clientIds = Array.from(new Set((data || []).map((sh) => sh.client_id)));
    let clientsById = {};
    if (clientIds.length > 0) {
      const { data: clients } = await supabase
        .from('clients')
        .select('id, first_name, last_name')
        .in('id', clientIds);
      clientsById = Object.fromEntries((clients || []).map((c) => [c.id, c]));
    }
    setShifts((data || []).map((sh) => ({ ...sh, client: clientsById[sh.client_id] || null })));
  }, [caregiver.id]);

  useEffect(() => {
    let cancelled = false;
    load().catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [load]);

  const groups = groupShiftsByDay(shifts || []);

  return (
    <div className={s.page}>
      <Link className={s.linkBtn} to="/care">← Back to shifts</Link>
      <header className={s.header}>
        <div>
          <div className={s.muted}>Last {HISTORY_DAYS} days</div>
          <h1 className={s.pageTitle}>Shift history</h1>
        </div>
      </header>

      {usingCache && (
        <div className={s.cacheNotice} role="status">
          <CloudOff size={14} aria-hidden="true" />
          <span>Showing saved history — you appear to be offline.</span>
        </div>
      )}

      {error && <div className={s.error}>{error}</div>}

      {shifts == null && !error && <div className={s.muted}>Loading…</div>}

      {shifts && shifts.length === 0 && (
        <div className={s.emptyCard}>
          <p>No past shifts in the last {HISTORY_DAYS} days.</p>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.key} className={s.historyGroup}>
          <h2 className={s.historyDay}>{dayFmt.format(group.date)}</h2>
          <ul className={s.shiftList}>
            {group.shifts.map((sh) => {
              const clientName = sh.client
                ? `${sh.client.first_name || ''} ${sh.client.last_name || ''}`.trim() || 'Client'
                : 'Client';
              return (
                <li key={sh.id}>
                  <Link className={s.shiftCard} to={`/care/shifts/${sh.id}`}>
                    <div className={s.shiftDay}>{timeFmt.format(new Date(sh.start_time))}</div>
                    <div className={s.shiftTime}>{timeFmt.format(new Date(sh.end_time))}</div>
                    <div className={s.shiftClient}>{clientName}</div>
                    <div className={s.shiftStatus}>{STATUS_LABEL[sh.status] || sh.status}</div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
