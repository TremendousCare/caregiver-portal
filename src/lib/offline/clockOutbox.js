// ─── Clock outbox ───
// A durable queue of clock-in / clock-out events captured while the
// caregiver had no connectivity (or the request failed mid-flight). Each
// entry carries the caregiver's real tap time (`occurred_at` in the body)
// and GPS, so when it finally syncs the server records the event at the
// time it actually happened — not the time it synced.
//
// The flush logic is pure and store-agnostic so it can be unit-tested
// against an in-memory store with a fake `call`.

import { makeIdbStore, STORES } from './idb';

// Classify a failed clock submit so the flusher knows what to do:
//   'duplicate'  — already recorded server-side; drop it, it's done
//   'permanent'  — server rejected it (validation/geofence/bad status);
//                  keep it but flag for the caregiver, stop blocking others
//   'transient'  — offline / timeout / 5xx / auth; leave queued, retry later
//
// Reads `err.isNetworkError`, `err.httpStatus`, and `err.code` which
// callCaregiverClock attaches to the thrown error.
export function classifyClockError(err) {
  if (!err) return 'transient';
  if (err.isNetworkError) return 'transient';
  if (err.code === 'duplicate_event') return 'duplicate';

  const status = err.httpStatus;
  if (!status) return 'transient';
  if (status === 401 || status === 408 || status === 429) return 'transient';
  if (status >= 500) return 'transient';
  if (status === 409) {
    // 409 with no duplicate_event code = a status-transition conflict
    // (e.g. clocking out before the queued clock-in has applied). Treat
    // as permanent so it surfaces rather than silently vanishing.
    return 'permanent';
  }
  if (status >= 400) return 'permanent';
  return 'transient';
}

export function createClockOutbox(store = makeIdbStore(STORES.clockOutbox)) {
  return {
    // entry: { id, shiftId, eventType, body, createdAt }
    async enqueue(entry) {
      const row = {
        status: 'pending',
        attempts: 0,
        error: null,
        ...entry,
      };
      await store.put(row);
      return row;
    },

    // Oldest first — clock-in must flush before the matching clock-out.
    async list() {
      const all = await store.getAll();
      return all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    },

    async pendingForShift(shiftId) {
      const all = await this.list();
      return all.filter((e) => e.shiftId === shiftId && e.status !== 'failed');
    },

    async count() {
      const all = await store.getAll();
      return all.filter((e) => e.status !== 'failed').length;
    },

    async remove(id) {
      await store.delete(id);
    },

    async markFailed(id, message) {
      const row = await store.get(id);
      if (!row) return;
      await store.put({
        ...row,
        status: 'failed',
        attempts: (row.attempts || 0) + 1,
        error: message || 'Could not sync.',
      });
    },
  };
}

// Flush all pending entries oldest-first. `call(body)` should resolve on
// success and reject with an error carrying httpStatus/isNetworkError/code
// on failure (callCaregiverClock does this). Stops at the first transient
// failure so we don't hammer the network while offline, and so a queued
// clock-in is retried before its clock-out.
export async function flushClockOutbox({ outbox, call, isOnline }) {
  const result = { flushed: 0, failed: 0, remaining: 0, stopped: false };

  if (typeof isOnline === 'function' && !isOnline()) {
    result.remaining = await outbox.count();
    return result;
  }

  const entries = (await outbox.list()).filter((e) => e.status !== 'failed');

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      await call(entry.body);
      // eslint-disable-next-line no-await-in-loop
      await outbox.remove(entry.id);
      result.flushed += 1;
    } catch (err) {
      const kind = classifyClockError(err);
      if (kind === 'duplicate') {
        // eslint-disable-next-line no-await-in-loop
        await outbox.remove(entry.id);
        result.flushed += 1;
      } else if (kind === 'permanent') {
        // eslint-disable-next-line no-await-in-loop
        await outbox.markFailed(entry.id, err?.message);
        result.failed += 1;
      } else {
        // Transient — stop and retry the whole queue later.
        result.stopped = true;
        result.remaining = entries.length - i;
        return result;
      }
    }
  }

  return result;
}
