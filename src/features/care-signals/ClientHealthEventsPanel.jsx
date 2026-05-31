import { useState, useEffect, useCallback } from 'react';
import {
  Building2,
  Ambulance,
  TrendingDown,
  Thermometer,
  Home,
  Heart,
  CircleDot,
  Plus,
  Activity,
  RotateCcw,
} from 'lucide-react';
import { fetchHealthEvents, logHealthEvent } from './clientHealthEventsActions';
import {
  EVENT_TYPES,
  eventTypeMeta,
  eventTypeLabel,
  sortHealthEvents,
  isReadmission,
} from './healthEventHelpers';

const TYPE_ICONS = { Building2, Ambulance, TrendingDown, Thermometer, Home, Heart, CircleDot };

const TONE_COLOR = {
  danger: '#dc2626',
  warning: '#d97706',
  info: '#2563eb',
  neutral: '#64748b',
};

function nowLocalDatetimeValue() {
  // datetime-local wants YYYY-MM-DDTHH:mm in local time.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TypeIcon({ type, size = 16 }) {
  const meta = eventTypeMeta(type);
  const Icon = TYPE_ICONS[meta.icon] || CircleDot;
  return <Icon size={size} color={TONE_COLOR[meta.tone] || TONE_COLOR.neutral} />;
}

function LogEventForm({ onSubmit, onCancel, busy, error }) {
  const [eventType, setEventType] = useState('hospitalization');
  const [occurredAt, setOccurredAt] = useState(nowLocalDatetimeValue());
  const [note, setNote] = useState('');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: '#f8fafc', borderRadius: 10, padding: 14 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ flex: '1 1 160px', fontSize: 12, color: '#475569', fontWeight: 600 }}>
          Type
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            style={{ width: '100%', marginTop: 4, padding: '7px 8px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 13 }}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {eventTypeLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: '1 1 200px', fontSize: 12, color: '#475569', fontWeight: 600 }}>
          When
          <input
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
            style={{ width: '100%', marginTop: 4, padding: '7px 8px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 13, boxSizing: 'border-box' }}
          />
        </label>
      </div>
      <label style={{ fontSize: 12, color: '#475569', fontWeight: 600 }}>
        Note (optional)
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. admitted for chest pain; family reported"
          style={{ width: '100%', marginTop: 4, padding: '7px 8px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 13, boxSizing: 'border-box' }}
        />
      </label>
      {error && <p style={{ color: '#dc2626', fontSize: 13, margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => onSubmit({ eventType, occurredAt, note, source: 'office' })}
          disabled={busy}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: '#1e293b', color: '#fff', border: 'none' }}
        >
          <Plus size={14} /> Log event
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{ padding: '7px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: '#fff', color: '#334155', border: '1px solid #cbd5e1' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ClientHealthEventsPanel({ client, currentUser }) {
  const clientId = client?.id;
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    try {
      const rows = await fetchHealthEvents(clientId);
      setEvents(sortHealthEvents(rows));
      setAvailable(true);
    } catch (err) {
      // Table not deployed yet / RLS — hide the panel rather than error.
      console.warn('[ClientHealthEventsPanel] load failed', err);
      setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = async (input) => {
    setBusy(true);
    setError(null);
    try {
      await logHealthEvent({ ...input, clientId }, { currentUser });
      setAdding(false);
      await load();
    } catch (err) {
      console.error('[ClientHealthEventsPanel] log failed', err);
      setError(err.message || 'Could not log event');
    } finally {
      setBusy(false);
    }
  };

  // If the table isn't available yet, render nothing (pre-deploy safe).
  if (!available && !loading) return null;

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 16,
        border: '1px solid #e8eef5',
        padding: 20,
        marginBottom: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Activity size={18} color="#475569" />
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1e293b' }}>Health Events</h3>
        </div>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: '#fff', color: '#334155', border: '1px solid #cbd5e1' }}
          >
            <Plus size={14} /> Log event
          </button>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
        Hospitalizations, ED visits, falls and discharges. Logged here so we can measure outcomes and
        report readmission trends to referral partners.
      </p>

      {adding && <LogEventForm onSubmit={handleSubmit} onCancel={() => { setAdding(false); setError(null); }} busy={busy} error={error} />}

      {events.length === 0 ? (
        !adding && <p style={{ margin: 0, fontSize: 13, color: '#94a3b8' }}>No events logged.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {events.map((ev) => {
            const readmit = isReadmission(ev, events);
            return (
              <li key={ev.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
                <span style={{ marginTop: 2 }}><TypeIcon type={ev.eventType} /></span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#1e293b' }}>{eventTypeLabel(ev.eventType)}</span>
                    {readmit && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 999, padding: '1px 8px' }}>
                        <RotateCcw size={11} /> 30-day readmission
                      </span>
                    )}
                    {ev.precedingSignalId && (
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#1d4ed8', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 999, padding: '1px 8px' }}>
                        Signal preceded
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>
                    {ev.occurredAt ? new Date(ev.occurredAt).toLocaleString() : ''}
                    {ev.recordedBy ? ` · logged by ${ev.recordedBy}` : ''}
                  </div>
                  {ev.note && <div style={{ fontSize: 13, color: '#475569', marginTop: 2 }}>{ev.note}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default ClientHealthEventsPanel;
