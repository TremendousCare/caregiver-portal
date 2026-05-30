import { describe, it, expect, vi } from 'vitest';
import { createMemoryStore } from '../idb';
import {
  classifyClockError,
  createClockOutbox,
  flushClockOutbox,
} from '../clockOutbox';

function err({ httpStatus, isNetworkError, code, message } = {}) {
  const e = new Error(message || 'fail');
  if (httpStatus) e.httpStatus = httpStatus;
  if (isNetworkError) e.isNetworkError = true;
  if (code) e.code = code;
  return e;
}

describe('classifyClockError', () => {
  it('treats network/offline errors as transient', () => {
    expect(classifyClockError(err({ isNetworkError: true }))).toBe('transient');
    expect(classifyClockError(undefined)).toBe('transient');
    expect(classifyClockError(err({}))).toBe('transient'); // no status
  });

  it('treats 5xx / 401 / 429 as transient', () => {
    expect(classifyClockError(err({ httpStatus: 500 }))).toBe('transient');
    expect(classifyClockError(err({ httpStatus: 503 }))).toBe('transient');
    expect(classifyClockError(err({ httpStatus: 401 }))).toBe('transient');
    expect(classifyClockError(err({ httpStatus: 429 }))).toBe('transient');
  });

  it('treats explicit duplicate_event code as duplicate', () => {
    expect(classifyClockError(err({ httpStatus: 409, code: 'duplicate_event' }))).toBe('duplicate');
  });

  it('treats a bare 409 (status conflict) as permanent', () => {
    expect(classifyClockError(err({ httpStatus: 409 }))).toBe('permanent');
  });

  it('treats other 4xx as permanent', () => {
    expect(classifyClockError(err({ httpStatus: 400 }))).toBe('permanent');
    expect(classifyClockError(err({ httpStatus: 403 }))).toBe('permanent');
    expect(classifyClockError(err({ httpStatus: 404 }))).toBe('permanent');
  });
});

describe('createClockOutbox', () => {
  const entry = (over = {}) => ({
    id: over.id || crypto.randomUUID(),
    shiftId: over.shiftId || 'shift-1',
    eventType: over.eventType || 'in',
    body: over.body || {},
    createdAt: over.createdAt ?? Date.now(),
  });

  it('enqueues with pending status and lists oldest-first', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry({ id: 'b', createdAt: 200 }));
    await outbox.enqueue(entry({ id: 'a', createdAt: 100 }));
    const list = await outbox.list();
    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
    expect(list[0].status).toBe('pending');
  });

  it('counts only non-failed entries', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry({ id: 'a' }));
    await outbox.enqueue(entry({ id: 'b' }));
    await outbox.markFailed('b', 'rejected');
    expect(await outbox.count()).toBe(1);
  });

  it('pendingForShift excludes failed and other shifts', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry({ id: 'a', shiftId: 's1' }));
    await outbox.enqueue(entry({ id: 'b', shiftId: 's2' }));
    await outbox.enqueue(entry({ id: 'c', shiftId: 's1' }));
    await outbox.markFailed('c', 'x');
    const pending = await outbox.pendingForShift('s1');
    expect(pending.map((e) => e.id)).toEqual(['a']);
  });
});

describe('flushClockOutbox', () => {
  const entry = (id, createdAt, eventType = 'in') => ({
    id,
    shiftId: 's1',
    eventType,
    body: { shift_id: 's1', event_type: eventType },
    createdAt,
  });

  it('does nothing and reports remaining when offline', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry('a', 1));
    const call = vi.fn();
    const res = await flushClockOutbox({ outbox, call, isOnline: () => false });
    expect(call).not.toHaveBeenCalled();
    expect(res.remaining).toBe(1);
    expect(res.flushed).toBe(0);
  });

  it('flushes all entries in order on success', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry('in', 1, 'in'));
    await outbox.enqueue(entry('out', 2, 'out'));
    const seen = [];
    const call = vi.fn(async (body) => { seen.push(body.event_type); });
    const res = await flushClockOutbox({ outbox, call, isOnline: () => true });
    expect(seen).toEqual(['in', 'out']);
    expect(res.flushed).toBe(2);
    expect(await outbox.count()).toBe(0);
  });

  it('removes duplicates (already recorded) and continues', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry('in', 1, 'in'));
    await outbox.enqueue(entry('out', 2, 'out'));
    const call = vi.fn(async (body) => {
      if (body.event_type === 'in') {
        const e = new Error('already clocked in');
        e.httpStatus = 409;
        e.code = 'duplicate_event';
        throw e;
      }
    });
    const res = await flushClockOutbox({ outbox, call, isOnline: () => true });
    expect(res.flushed).toBe(2);
    expect(await outbox.count()).toBe(0);
  });

  it('stops at the first transient failure, leaving the queue intact', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry('in', 1, 'in'));
    await outbox.enqueue(entry('out', 2, 'out'));
    const call = vi.fn(async () => {
      const e = new Error('offline');
      e.isNetworkError = true;
      throw e;
    });
    const res = await flushClockOutbox({ outbox, call, isOnline: () => true });
    expect(res.stopped).toBe(true);
    expect(res.flushed).toBe(0);
    expect(res.remaining).toBe(2);
    expect(call).toHaveBeenCalledTimes(1); // stopped after first
    expect(await outbox.count()).toBe(2);
  });

  it('flags permanent rejections as failed and keeps going', async () => {
    const outbox = createClockOutbox(createMemoryStore());
    await outbox.enqueue(entry('in', 1, 'in'));
    await outbox.enqueue(entry('out', 2, 'out'));
    const call = vi.fn(async (body) => {
      if (body.event_type === 'in') {
        const e = new Error('outside geofence, no override');
        e.httpStatus = 403;
        throw e;
      }
    });
    const res = await flushClockOutbox({ outbox, call, isOnline: () => true });
    expect(res.failed).toBe(1);
    expect(res.flushed).toBe(1);
    // The clock-out flushed; the failed clock-in is retained but flagged,
    // so it no longer counts toward the "waiting to sync" badge.
    expect(await outbox.count()).toBe(0);
    const remaining = await outbox.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe('failed');
  });
});
