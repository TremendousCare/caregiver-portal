// ─── Shift-window enforcement ───
// Pure functions for deciding whether a clock-in / clock-out attempt
// falls inside the acceptable window around a shift's scheduled times.
// The caregiver-clock edge function enforces these rules server-side;
// the PWA mirrors them for immediate UX feedback before the network
// round-trip.
//
// The windows are deliberately asymmetric:
//   - Clock-in:  start_time - 15 min  ..  end_time
//                Caregivers can show up a little early, but if the
//                shift has already ended they shouldn't be clocking in.
//   - Clock-out: start_time           ..  end_time + 60 min
//                Visits often run long; we allow up to an hour past
//                scheduled end before requiring an override reason.
//
// A caregiver can override an out-of-window attempt with an
// override_reason — same channel as a geofence override — which is
// logged on clock_events for admin review.

export const CLOCK_IN_GRACE_BEFORE_MIN = 15;
export const CLOCK_OUT_GRACE_AFTER_MIN = 60;

const MIN_MS = 60_000;

function toMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  if (typeof t === 'string') return Date.parse(t);
  return NaN;
}

/**
 * Decide whether `now` is inside the allowed window for the requested
 * clock event. Returns one of:
 *   { passed: true }
 *   { passed: false, reason: 'too_early', minutesEarly }
 *   { passed: false, reason: 'too_late',  minutesLate }
 *   { passed: false, reason: 'invalid_time' }
 *   { passed: false, reason: 'invalid_event_type' }
 */
export function evaluateShiftWindow({
  now,
  startTime,
  endTime,
  eventType,
  graceBeforeMin = CLOCK_IN_GRACE_BEFORE_MIN,
  graceAfterMin = CLOCK_OUT_GRACE_AFTER_MIN,
}) {
  const nowMs = toMs(now);
  const startMs = toMs(startTime);
  const endMs = toMs(endTime);

  if (!Number.isFinite(nowMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { passed: false, reason: 'invalid_time' };
  }

  let earliestMs;
  let latestMs;
  if (eventType === 'in') {
    earliestMs = startMs - graceBeforeMin * MIN_MS;
    latestMs = endMs;
  } else if (eventType === 'out') {
    earliestMs = startMs;
    latestMs = endMs + graceAfterMin * MIN_MS;
  } else {
    return { passed: false, reason: 'invalid_event_type' };
  }

  if (nowMs < earliestMs) {
    return {
      passed: false,
      reason: 'too_early',
      minutesEarly: Math.ceil((earliestMs - nowMs) / MIN_MS),
    };
  }
  if (nowMs > latestMs) {
    return {
      passed: false,
      reason: 'too_late',
      minutesLate: Math.ceil((nowMs - latestMs) / MIN_MS),
    };
  }
  return { passed: true };
}
