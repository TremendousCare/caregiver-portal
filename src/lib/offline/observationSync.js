// ─── Observation sync (offline care-plan logging) ───
// Mirrors the clock outbox for care_plan_observations: task ratings,
// notes, and refusals logged with no connectivity are queued and synced
// when the caregiver reconnects. Each observation carries a
// client-generated client_obs_id so a retried sync is idempotent (the
// unique index turns the second insert into a no-op we drop from the queue).
//
// Care-plan reference data (plan/version/tasks/observations) is cached per
// shift so the checklist renders offline.

import { supabase } from '../supabase';
import { makeIdbStore, STORES } from './idb';
import { createClockOutbox } from './clockOutbox';

// createClockOutbox is a generic durable queue (id/shiftId/createdAt/status)
// — reused here for observations, bound to its own object store.
export const observationOutbox = createClockOutbox(makeIdbStore(STORES.observationOutbox));

const carePlanStore = makeIdbStore(STORES.carePlanCache);

const CHANGE_EVENT = 'tc-observation-outbox-changed';

export function emitObservationsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onObservationsChanged(handler) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

export function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

// Distinguish "couldn't reach the server" (queue + retry) from a genuine
// server rejection like a CHECK-constraint violation (surface it). A coded
// Postgres/PostgREST error means the request reached the DB.
export function isLikelyOfflineError(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!err) return false;
  if (err.code) return false;
  const msg = String(err.message || err).toLowerCase();
  return /fetch|network|failed to fetch|networkerror|load failed/.test(msg);
}

// ── Care-plan reference cache (per shift) ──
export const carePlanCache = {
  async put(shiftId, payload) {
    if (!shiftId) return;
    await carePlanStore.put({ id: shiftId, ...payload, cachedAt: Date.now() });
  },
  async get(shiftId) {
    if (!shiftId) return null;
    return carePlanStore.get(shiftId);
  },
};

// Map a queued snake_case row to a camelCase observation for optimistic
// display while it waits to sync.
export function pendingRowToObservation(row) {
  return {
    id: row.client_obs_id,
    clientObsId: row.client_obs_id,
    carePlanId: row.care_plan_id,
    versionId: row.version_id,
    taskId: row.task_id ?? null,
    systemDefaultTaskId: row.system_default_task_id ?? null,
    shiftId: row.shift_id ?? null,
    caregiverId: row.caregiver_id ?? null,
    observationType: row.observation_type,
    rating: row.rating ?? null,
    note: row.note ?? null,
    loggedAt: row.logged_at || new Date().toISOString(),
    createdAt: row.created_at || row.logged_at || new Date().toISOString(),
    pending: true,
  };
}

export async function listPendingObservations(shiftId) {
  const entries = await observationOutbox.pendingForShift(shiftId);
  return entries.map((e) => pendingRowToObservation(e.row));
}

export async function pendingObservationCount() {
  return observationOutbox.count();
}

// Submit an observation row. Online → insert; offline / network failure →
// queue (stamping logged_at with the real log time). Returns the
// snake_case row that was saved/queued so the caller can map it.
export async function submitObservation(row) {
  if (isOnline()) {
    try {
      const { data, error } = await supabase
        .from('care_plan_observations')
        .insert(row)
        .select()
        .single();
      if (!error && data) return { row: data, queued: false };
      if (error && !isLikelyOfflineError(error)) {
        const e = new Error(error.message || 'Could not save observation.');
        e.code = error.code;
        throw e;
      }
      // looked offline → fall through to queue
    } catch (err) {
      if (err?.code) throw err; // real, classified rejection
      if (!isLikelyOfflineError(err)) throw err;
      // network throw → queue
    }
  }

  const queuedRow = { ...row, logged_at: row.logged_at || new Date().toISOString() };
  await observationOutbox.enqueue({
    id: queuedRow.client_obs_id,
    shiftId: queuedRow.shift_id,
    row: queuedRow,
    createdAt: Date.now(),
  });
  emitObservationsChanged();
  flushObservationsNow();
  return { row: queuedRow, queued: true };
}

// Flush the observation queue. `insert(row)` resolves to {data,error}
// (Supabase shape). Stops on the first transient (offline) failure;
// drops duplicates (already inserted); flags genuine rejections.
export async function flushObservationOutbox({ outbox, insert, isOnline: online }) {
  const result = { flushed: 0, failed: 0, remaining: 0, stopped: false };
  if (typeof online === 'function' && !online()) {
    result.remaining = await outbox.count();
    return result;
  }

  const entries = (await outbox.list()).filter((e) => e.status !== 'failed');
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const { error } = await insert(entry.row);
      if (!error) {
        // eslint-disable-next-line no-await-in-loop
        await outbox.remove(entry.id);
        result.flushed += 1;
      } else if (error.code === '23505') {
        // Unique violation on client_obs_id = already saved on a prior try.
        // eslint-disable-next-line no-await-in-loop
        await outbox.remove(entry.id);
        result.flushed += 1;
      } else if (isLikelyOfflineError(error)) {
        result.stopped = true;
        result.remaining = entries.length - i;
        return result;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await outbox.markFailed(entry.id, error.message);
        result.failed += 1;
      }
    } catch (err) {
      if (isLikelyOfflineError(err)) {
        result.stopped = true;
        result.remaining = entries.length - i;
        return result;
      }
      // eslint-disable-next-line no-await-in-loop
      await outbox.markFailed(entry.id, err?.message);
      result.failed += 1;
    }
  }
  return result;
}

let flushing = false;

export async function flushObservationsNow() {
  if (flushing || !isOnline()) return null;
  flushing = true;
  try {
    const res = await flushObservationOutbox({
      outbox: observationOutbox,
      insert: (row) => supabase.from('care_plan_observations').insert(row).select().single(),
      isOnline,
    });
    if (res && (res.flushed > 0 || res.failed > 0)) emitObservationsChanged();
    return res;
  } catch (err) {
    console.error('[observation-sync] flush failed:', err);
    return null;
  } finally {
    flushing = false;
  }
}
