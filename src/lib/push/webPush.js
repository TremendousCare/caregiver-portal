// ─── Web Push helpers (pure) ───
// Conversion + serialization utilities for the caregiver push flow, kept
// free of DOM/network so they can be unit-tested. The subscribe/save
// side-effects live in pushClient.js.

// Convert a base64url VAPID public key into the Uint8Array the
// PushManager.subscribe() applicationServerKey option requires.
export function urlBase64ToUint8Array(base64String) {
  if (!base64String) throw new Error('Missing VAPID public key.');
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

// Flatten a PushSubscription (or its toJSON form) into the columns the
// push_subscriptions table stores. Returns null if the shape is invalid.
export function serializeSubscription(subscription) {
  if (!subscription) return null;
  const json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
  const endpoint = json?.endpoint;
  const p256dh = json?.keys?.p256dh;
  const auth = json?.keys?.auth;
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, p256dh, auth };
}

// Build the notification payload for a shift reminder. Pure so the copy
// and shape are unit-tested and consistent between the cron sender and
// any ad-hoc send.
export function buildReminderPayload({ clientName, startTime, shiftId, minutesUntil }) {
  const name = clientName || 'your client';
  const when = formatWhen(startTime, minutesUntil);
  return {
    title: 'Upcoming shift',
    body: `Shift with ${name}${when}.`,
    url: shiftId ? `/care/shifts/${shiftId}` : '/care',
    tag: shiftId ? `shift-${shiftId}` : 'shift-reminder',
  };
}

function formatWhen(startTime, minutesUntil) {
  if (Number.isFinite(minutesUntil)) {
    if (minutesUntil <= 0) return ' now';
    if (minutesUntil < 60) return ` in ${minutesUntil} min`;
  }
  if (startTime) {
    const d = new Date(startTime);
    if (!Number.isNaN(d.getTime())) {
      try {
        return ` at ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d)}`;
      } catch {
        return '';
      }
    }
  }
  return '';
}
