import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMemoryStore } from '../idb';
import { createClockOutbox } from '../clockOutbox';
import {
  flushObservationOutbox,
  isLikelyOfflineError,
  pendingRowToObservation,
} from '../observationSync';

function row(id, over = {}) {
  return {
    client_obs_id: id,
    care_plan_id: 'plan-1',
    version_id: 'ver-1',
    shift_id: 's1',
    observation_type: 'task_completion',
    rating: 'done',
    ...over,
  };
}

function entry(id, createdAt) {
  return { id, shiftId: 's1', row: row(id), createdAt };
}

afterEach(() => {
  // restore any navigator.onLine override
  try {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  } catch { /* ignore */ }
});

describe('isLikelyOfflineError', () => {
  it('is true when navigator reports offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    expect(isLikelyOfflineError({ code: '23505' })).toBe(true); // offline overrides
  });

  it('is false for a coded DB error when online', () => {
    expect(isLikelyOfflineError({ code: '23514', message: 'check violation' })).toBe(false);
  });

  it('is true for an uncoded fetch/network error', () => {
    expect(isLikelyOfflineError(new Error('TypeError: Failed to fetch'))).toBe(true);
    expect(isLikelyOfflineError({ message: 'NetworkError when attempting to fetch' })).toBe(true);
  });

  it('is false for null/no info when online', () => {
    expect(isLikelyOfflineError(null)).toBe(false);
  });
});

describe('pendingRowToObservation', () => {
  it('maps snake_case row to a pending observation', () => {
    const obs = pendingRowToObservation(row('abc', { note: 'hi', logged_at: '2026-05-30T10:00:00Z' }));
    expect(obs).toMatchObject({
      id: 'abc',
      clientObsId: 'abc',
      carePlanId: 'plan-1',
      versionId: 'ver-1',
      observationType: 'task_completion',
      rating: 'done',
      note: 'hi',
      loggedAt: '2026-05-30T10:00:00Z',
      pending: true,
    });
  });

  it('fills loggedAt when absent', () => {
    const obs = pendingRowToObservation(row('x'));
    expect(typeof obs.loggedAt).toBe('string');
    expect(obs.pending).toBe(true);
  });
});

describe('flushObservationOutbox', () => {
  it('inserts each queued observation and clears the queue', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry('a', 1));
    await outbox.enqueue(entry('b', 2));
    const insert = vi.fn(async () => ({ data: {}, error: null }));
    const res = await flushObservationOutbox({ outbox, insert, isOnline: () => true });
    expect(res.flushed).toBe(2);
    expect(await outbox.count()).toBe(0);
  });

  it('drops a duplicate (unique violation) as already-saved', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry('a', 1));
    const insert = vi.fn(async () => ({ data: null, error: { code: '23505', message: 'dup' } }));
    const res = await flushObservationOutbox({ outbox, insert, isOnline: () => true });
    expect(res.flushed).toBe(1);
    expect(await outbox.count()).toBe(0);
  });

  it('stops at a transient (offline) error, leaving the queue', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry('a', 1));
    await outbox.enqueue(entry('b', 2));
    const insert = vi.fn(async () => ({ data: null, error: { message: 'Failed to fetch' } }));
    const res = await flushObservationOutbox({ outbox, insert, isOnline: () => true });
    expect(res.stopped).toBe(true);
    expect(res.flushed).toBe(0);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(await outbox.count()).toBe(2);
  });

  it('flags a genuine rejection as failed and continues', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry('a', 1));
    await outbox.enqueue(entry('b', 2));
    const insert = vi.fn(async (r) => {
      if (r.client_obs_id === 'a') return { data: null, error: { code: '23514', message: 'check' } };
      return { data: {}, error: null };
    });
    const res = await flushObservationOutbox({ outbox, insert, isOnline: () => true });
    expect(res.failed).toBe(1);
    expect(res.flushed).toBe(1);
    expect(await outbox.count()).toBe(0); // failed excluded from count
    const all = await outbox.list();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('failed');
  });

  it('does nothing when offline', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry('a', 1));
    const insert = vi.fn();
    const res = await flushObservationOutbox({ outbox, insert, isOnline: () => false });
    expect(insert).not.toHaveBeenCalled();
    expect(res.remaining).toBe(1);
  });
});
