// ─── Push client (subscribe / save / unsubscribe) ───
// Side-effecting half of the caregiver push flow. Pure conversion helpers
// live in webPush.js. The VAPID public key is injected at build time
// (VITE_VAPID_PUBLIC_KEY); when it's absent, push is treated as
// unconfigured and the UI hides the opt-in.

import { supabase } from '../supabase';
import { urlBase64ToUint8Array, serializeSubscription } from './webPush';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function pushConfigured() {
  return Boolean(VAPID_PUBLIC_KEY);
}

export function notificationPermission() {
  return typeof Notification !== 'undefined' ? Notification.permission : 'denied';
}

export async function getExistingSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// Request permission, subscribe via PushManager, and persist the
// subscription for this caregiver. Throws a user-friendly Error on failure.
export async function enablePush(caregiverId) {
  if (!pushSupported()) throw new Error('Notifications aren’t supported on this device.');
  if (!pushConfigured()) throw new Error('Notifications aren’t set up yet — contact your coordinator.');
  if (!caregiverId) throw new Error('Missing caregiver — please sign in again.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notifications are blocked. Enable them in your browser settings to get reminders.');
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const ser = serializeSubscription(sub);
  if (!ser) throw new Error('Could not read the push subscription.');

  // Upsert by endpoint (unique) so re-enabling the same device is a no-op
  // rather than a duplicate row.
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        caregiver_id: caregiverId,
        endpoint: ser.endpoint,
        p256dh: ser.p256dh,
        auth: ser.auth,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        last_seen_at: new Date().toISOString(),
        disabled_at: null,
      },
      { onConflict: 'endpoint' },
    );
  if (error) throw error;

  // Fire a confirmation push so the caregiver sees it working immediately.
  // Non-blocking: never let invoke() hang or fail the opt-in.
  try {
    supabase.functions.invoke('send-push', { body: {} }).catch(() => {});
  } catch (_) {
    // ignore
  }
  return true;
}

export async function disablePush() {
  const sub = await getExistingSubscription();
  if (!sub) return;
  const ser = serializeSubscription(sub);
  try {
    await sub.unsubscribe();
  } catch (_) {
    // ignore — we still drop the server row below
  }
  if (ser?.endpoint) {
    await supabase.from('push_subscriptions').delete().eq('endpoint', ser.endpoint);
  }
}
