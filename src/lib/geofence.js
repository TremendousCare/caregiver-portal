// ─── Geofence helpers ───
// Pure functions for distance calculation and geofence gating. The
// caregiver-clock edge function recomputes distance server-side, but
// the PWA uses these utilities client-side to give the caregiver
// immediate feedback ("You're 0.4 mi away — clock-in blocked") before
// the network round-trip.

const EARTH_RADIUS_M = 6_371_000;

const toRadians = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two lat/lng points, in meters.
 * Uses the haversine formula. Accurate to within a few meters at the
 * scales we care about (a single residence).
 */
export function haversineMeters(a, b) {
  if (!a || !b) return null;
  const lat1 = Number(a.lat);
  const lng1 = Number(a.lng);
  const lat2 = Number(b.lat);
  const lng2 = Number(b.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;

  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  return EARTH_RADIUS_M * c;
}

/**
 * Decide whether a caregiver-reported position is inside a client's
 * geofence. We subtract GPS accuracy from the measured distance (best
 * case) so a fix with ±80m accuracy still passes when the true
 * distance is just outside the radius. This intentionally favors the
 * caregiver — the server-side check enforces the same rule.
 *
 * Returns {passed, distanceM, effectiveDistanceM} or {passed:false, reason}.
 */
export function evaluateGeofence({ caregiver, client, radiusM = 150, accuracyM = null }) {
  // Coerce explicitly so null/undefined become NaN instead of 0.
  const hasCoords = (p) =>
    p != null &&
    p.lat != null && p.lng != null &&
    Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

  if (!hasCoords(client)) return { passed: false, reason: 'client_not_geocoded' };
  if (!hasCoords(caregiver)) return { passed: false, reason: 'no_caregiver_fix' };

  const distanceM = haversineMeters(caregiver, client);
  if (distanceM == null) return { passed: false, reason: 'invalid_coords' };

  const accuracyGrace = Number.isFinite(Number(accuracyM)) ? Math.max(0, Number(accuracyM)) : 0;
  const effectiveDistanceM = Math.max(0, distanceM - accuracyGrace);
  const passed = effectiveDistanceM <= radiusM;

  return { passed, distanceM, effectiveDistanceM };
}

/**
 * Thin wrapper around navigator.geolocation.getCurrentPosition that
 * returns a promise. Rejects on timeout, permission denial, or when
 * the browser lacks geolocation support.
 */
export function getCurrentPosition({ timeoutMs = 10_000, enableHighAccuracy = true } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Geolocation is not supported on this device.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyM: pos.coords.accuracy,
        timestamp: pos.timestamp,
      }),
      (err) => reject(err),
      { enableHighAccuracy, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

/**
 * Formats a distance in meters for UI display. Uses feet / miles for
 * US audiences since caregivers think in imperial units.
 */
export function formatDistanceUs(meters) {
  if (!Number.isFinite(meters)) return '—';
  const feet = meters * 3.28084;
  if (feet < 1000) return `${Math.round(feet)} ft`;
  const miles = meters / 1609.344;
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}
