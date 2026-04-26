import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { getCurrentPosition, evaluateGeofence, formatDistanceUs } from '../../lib/geofence';
import { evaluateShiftWindow } from '../../lib/shiftWindow';
import { callCaregiverClock } from '../../lib/callCaregiverClock';
import { CarePlanChecklist } from './CarePlanChecklist';
import s from './CaregiverPortal.module.css';

const OVERRIDE_REASON_MAX_LEN = 250;
const OVERRIDE_REASON_MIN_LEN = 5;

function describeWindowFailure(windowResult, action) {
  if (!windowResult || windowResult.passed) return null;
  const verb = action === 'in' ? 'clock in' : 'clock out';
  if (windowResult.reason === 'too_early') {
    return `Too early to ${verb} — you’re ${windowResult.minutesEarly} min outside the allowed window.`;
  }
  if (windowResult.reason === 'too_late') {
    return `Too late to ${verb} — you’re ${windowResult.minutesLate} min outside the allowed window.`;
  }
  return null;
}

const dtFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit',
});

// Maps the current shift status to which action is available.
function primaryActionFor(status) {
  if (status === 'assigned' || status === 'confirmed') return 'in';
  if (status === 'in_progress') return 'out';
  return null;
}

function buildMapsUrl(client) {
  const parts = [client.address, client.city, client.state, client.zip].filter(Boolean);
  if (parts.length === 0) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(', '))}`;
}

export function CaregiverShiftDetail({ caregiver }) {
  const { shiftId } = useParams();
  const [shift, setShift] = useState(null);
  const [client, setClient] = useState(null);
  const [clockEvents, setClockEvents] = useState([]);
  const [loadErr, setLoadErr] = useState(null);

  // Clock-in state machine
  //   idle → locating → ready (passed) | blocked (failed) → submitting → done/error
  const [clockState, setClockState] = useState('idle');
  const [locationResult, setLocationResult] = useState(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [submitError, setSubmitError] = useState(null);

  const loadShift = useCallback(async () => {
    setLoadErr(null);
    const { data: sh, error: shErr } = await supabase
      .from('shifts')
      .select('id, client_id, assigned_caregiver_id, start_time, end_time, status, instructions')
      .eq('id', shiftId)
      .maybeSingle();
    if (shErr) { setLoadErr(shErr.message); return; }
    if (!sh) { setLoadErr('Shift not found or not assigned to you.'); return; }
    setShift(sh);

    const { data: cl } = await supabase
      .from('clients')
      .select('id, first_name, last_name, address, city, state, zip, latitude, longitude, geofence_radius_m')
      .eq('id', sh.client_id)
      .maybeSingle();
    setClient(cl);

    const { data: events } = await supabase
      .from('clock_events')
      .select('id, event_type, occurred_at, geofence_passed, distance_from_client_m, override_reason')
      .eq('shift_id', shiftId)
      .order('occurred_at', { ascending: true });
    setClockEvents(events || []);
  }, [shiftId]);

  useEffect(() => { loadShift(); }, [loadShift]);

  const action = shift ? primaryActionFor(shift.status) : null;

  const getLocationAndEvaluate = async () => {
    setClockState('locating');
    setSubmitError(null);
    setOverrideReason('');
    try {
      const pos = await getCurrentPosition();
      const clientCoords = client?.latitude != null && client?.longitude != null
        ? { lat: Number(client.latitude), lng: Number(client.longitude) }
        : null;
      const evalResult = evaluateGeofence({
        caregiver: { lat: pos.lat, lng: pos.lng },
        client: clientCoords,
        radiusM: Number(client?.geofence_radius_m ?? 150),
        accuracyM: pos.accuracyM,
      });
      const windowResult = evaluateShiftWindow({
        now: new Date(),
        startTime: shift.start_time,
        endTime: shift.end_time,
        eventType: action,
      });
      setLocationResult({ pos, evalResult, windowResult });
      setClockState(evalResult.passed && windowResult.passed ? 'ready' : 'blocked');
    } catch (err) {
      setLocationResult(null);
      setSubmitError(
        err?.code === err?.PERMISSION_DENIED
          ? 'Location permission denied. Enable location in your browser settings to clock in.'
          : (err?.message || 'Could not get your location.'),
      );
      setClockState('idle');
    }
  };

  const submitClock = async () => {
    if (!locationResult || !shift) return;
    setClockState('submitting');
    setSubmitError(null);
    try {
      await callCaregiverClock({
        supabaseClient: supabase,
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
        anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        body: {
          shift_id: shift.id,
          event_type: action,
          latitude: locationResult.pos.lat,
          longitude: locationResult.pos.lng,
          accuracy_m: locationResult.pos.accuracyM,
          override_reason: overrideReason.trim() || undefined,
        },
      });
      setClockState('idle');
      setLocationResult(null);
      setOverrideReason('');
      await loadShift();
    } catch (err) {
      setSubmitError(err?.message || 'Could not record the clock event.');
      setClockState(
        locationResult?.evalResult?.passed && locationResult?.windowResult?.passed
          ? 'ready'
          : 'blocked',
      );
    }
  };

  if (loadErr) {
    return (
      <div className={s.page}>
        <div className={s.error}>{loadErr}</div>
        <Link className={s.linkBtn} to="/care">← Back to shifts</Link>
      </div>
    );
  }
  if (!shift) {
    return <div className={s.page}><div className={s.muted}>Loading…</div></div>;
  }

  const clientName = client
    ? `${client.first_name || ''} ${client.last_name || ''}`.trim() || 'Client'
    : 'Client';
  const mapsUrl = client ? buildMapsUrl(client) : null;
  const addressLine = client
    ? [client.address, client.city, client.state, client.zip].filter(Boolean).join(', ')
    : '';

  const windowFailureMessage = locationResult?.windowResult && !locationResult.windowResult.passed
    ? describeWindowFailure(locationResult.windowResult, action)
    : null;
  const geofenceFailed = locationResult?.evalResult && !locationResult.evalResult.passed;
  const geofenceMessage = !geofenceFailed
    ? null
    : locationResult.evalResult.reason === 'client_not_geocoded'
      ? 'This client’s address isn’t set up for geofencing yet.'
      : `You’re ${formatDistanceUs(locationResult.evalResult.distanceM)} from the client’s home — outside the allowed area.`;

  return (
    <div className={s.page}>
      <Link className={s.linkBtn} to="/care">← Back to shifts</Link>

      <section className={s.card}>
        <div className={s.muted}>{dtFmt.format(new Date(shift.start_time))}</div>
        <h1 className={s.title}>{clientName}</h1>
        <div className={s.muted}>
          {dtFmt.format(new Date(shift.start_time))} – {dtFmt.format(new Date(shift.end_time))}
        </div>
        {addressLine && (
          <div className={s.addressRow}>
            <span>{addressLine}</span>
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className={s.linkBtn}>
                Open in Maps
              </a>
            )}
          </div>
        )}
        {shift.instructions && (
          <div className={s.instructions}>
            <div className={s.muted}>Instructions</div>
            <div>{shift.instructions}</div>
          </div>
        )}
      </section>

      {action && (
        <section className={s.card}>
          {clockState === 'idle' && (
            <>
              <button className={s.primaryBtnLarge} onClick={getLocationAndEvaluate}>
                {action === 'in' ? 'Clock in' : 'Clock out'}
              </button>
              <p className={s.helper}>
                We&rsquo;ll check your location to confirm you&rsquo;re at the client&rsquo;s home.
              </p>
            </>
          )}

          {clockState === 'locating' && (
            <div className={s.muted}>Checking your location…</div>
          )}

          {clockState === 'ready' && locationResult?.evalResult?.passed && (
            <>
              <div className={s.successBanner}>
                You&rsquo;re at the client&rsquo;s home
                {locationResult.evalResult.distanceM != null && (
                  <> ({formatDistanceUs(locationResult.evalResult.distanceM)} away)</>
                )}.
              </div>
              <button className={s.primaryBtnLarge} onClick={submitClock}>
                Confirm {action === 'in' ? 'clock in' : 'clock out'}
              </button>
              <button className={s.linkBtn} onClick={() => { setClockState('idle'); setLocationResult(null); }}>
                Cancel
              </button>
            </>
          )}

          {clockState === 'blocked' && (
            <>
              <div className={s.errorBanner}>
                {windowFailureMessage && <div>{windowFailureMessage}</div>}
                {geofenceMessage && <div>{geofenceMessage}</div>}
              </div>
              <label className={s.label}>Override reason</label>
              <textarea
                className={s.textarea}
                rows={3}
                maxLength={OVERRIDE_REASON_MAX_LEN}
                placeholder="e.g. Client called us early; visit ran long for medication; GPS inaccurate in this building"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
              <p className={s.helper}>
                {overrideReason.length} / {OVERRIDE_REASON_MAX_LEN} — your coordinator will review this.
              </p>
              <button
                className={s.primaryBtnLarge}
                disabled={
                  overrideReason.trim().length < OVERRIDE_REASON_MIN_LEN
                  || overrideReason.length > OVERRIDE_REASON_MAX_LEN
                }
                onClick={submitClock}
              >
                {action === 'in' ? 'Clock in with override' : 'Clock out with override'}
              </button>
              <button
                className={s.linkBtn}
                onClick={() => { setClockState('idle'); setLocationResult(null); }}
              >
                Cancel
              </button>
            </>
          )}

          {clockState === 'submitting' && (
            <div className={s.muted}>Submitting…</div>
          )}

          {submitError && <div className={s.error}>{submitError}</div>}
        </section>
      )}

      {/* Care plan checklist — visible from `assigned` through `completed`.
          Read-only before clock-in, interactive while in_progress, locked
          after completion. Hides itself entirely for cancelled / no_show. */}
      <CarePlanChecklist shift={shift} caregiver={caregiver} />

      {!action && shift.status === 'completed' && (
        <section className={s.card}>
          <div className={s.successBanner}>Shift completed. Thank you!</div>
        </section>
      )}

      {clockEvents.length > 0 && (
        <section className={s.card}>
          <div className={s.muted}>Activity</div>
          <ul className={s.eventList}>
            {clockEvents.map((ev) => (
              <li key={ev.id}>
                <strong>{ev.event_type === 'in' ? 'Clocked in' : 'Clocked out'}</strong>{' '}
                <span className={s.muted}>at {dtFmt.format(new Date(ev.occurred_at))}</span>
                {ev.override_reason && (
                  <div className={s.muted}>Override: {ev.override_reason}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
