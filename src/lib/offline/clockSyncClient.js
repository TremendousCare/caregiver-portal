// ─── Clock sync client (app singletons + flush coordinator) ───
// Wires the pure outbox/cache logic to the real Supabase-backed clock
// edge function, and provides a single shared outbox/cache instance plus
// a change-event bus so any mounted caregiver screen can react when the
// queue drains.

import { supabase } from '../supabase';
import { callCaregiverClock } from '../callCaregiverClock';
import { createClockOutbox, flushClockOutbox } from './clockOutbox';
import { createShiftCache } from './shiftCache';

export const clockOutbox = createClockOutbox();
export const shiftCache = createShiftCache();

const CHANGE_EVENT = 'tc-clock-outbox-changed';

export function emitOutboxChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onOutboxChanged(handler) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

export function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

// The real call used to flush a queued event. Offline-queued bodies carry
// occurred_at + from_outbox so the server records them at the real tap time.
function callClock(body) {
  return callCaregiverClock({
    supabaseClient: supabase,
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    body,
  });
}

let flushing = false;

// Drain the outbox. Guarded so overlapping triggers (mount + online event
// + interval) don't run concurrently. Emits a change event if anything moved.
export async function flushClockNow() {
  if (flushing || !isOnline()) return null;
  flushing = true;
  try {
    const res = await flushClockOutbox({ outbox: clockOutbox, call: callClock, isOnline });
    if (res && (res.flushed > 0 || res.failed > 0)) emitOutboxChanged();
    return res;
  } catch (err) {
    console.error('[clock-sync] flush failed:', err);
    return null;
  } finally {
    flushing = false;
  }
}

// Queue a clock event for later sync. Stamps the real tap time + from_outbox.
export async function queueClockEvent({ shiftId, eventType, body }) {
  const entry = {
    id: crypto.randomUUID(),
    shiftId,
    eventType,
    body: { ...body, occurred_at: new Date().toISOString(), from_outbox: true },
    createdAt: Date.now(),
  };
  await clockOutbox.enqueue(entry);
  emitOutboxChanged();
  return entry;
}
