// ─── useClockSync / usePendingClockCount ───
// useClockSync: mounts the global auto-flush loop (on mount, on regaining
// connectivity, and on a slow interval while the app is open). Mount once,
// high in the caregiver tree.
//
// usePendingClockCount: read-only count of queued clock events for badges;
// safe to use in multiple components.

import { useEffect, useState, useCallback } from 'react';
import {
  clockOutbox,
  onOutboxChanged,
  flushClockNow,
  isOnline,
} from '../../../lib/offline/clockSyncClient';

const RETRY_MS = 30_000;

export function useClockSync() {
  useEffect(() => {
    let active = true;
    const tryFlush = () => {
      if (active && isOnline()) flushClockNow();
    };
    tryFlush();
    window.addEventListener('online', tryFlush);
    const iv = setInterval(tryFlush, RETRY_MS);
    return () => {
      active = false;
      window.removeEventListener('online', tryFlush);
      clearInterval(iv);
    };
  }, []);
}

export function usePendingClockCount() {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setCount(await clockOutbox.count());
    } catch {
      setCount(0);
    }
  }, []);

  useEffect(() => {
    refresh();
    const off = onOutboxChanged(refresh);
    return off;
  }, [refresh]);

  return count;
}
