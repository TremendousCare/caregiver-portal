import { useCallback, useEffect, useRef, useState } from 'react';

// ═══════════════════════════════════════════════════════════════
// useAutosave
//
// Debounced autosave hook used by the section editor drawer. Callers
// invoke `trigger(payload)` on every field change; the hook batches
// rapid changes into a single `saveFn` call after `delay` ms of quiet.
//
// State machine:
//   idle      → nothing pending
//   pending   → change queued, debounce timer ticking
//   saving    → saveFn in flight
//   saved     → saveFn resolved successfully (flickers for 2s)
//   error     → saveFn threw; error available via `error`
//
// The hook is intentionally generic — callers decide what the payload
// shape is. For our use, the SectionEditor passes a per-field patch.
//
// Callers should unmount the component or call `flush()` on close to
// avoid losing the last queued change.
// ═══════════════════════════════════════════════════════════════

export function useAutosave(saveFn, { delay = 1000, savedIndicatorMs = 2000 } = {}) {
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);

  const timerRef = useRef(null);
  const savedTimerRef = useRef(null);
  const latestRef = useRef(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
      clearTimeout(savedTimerRef.current);
    };
  }, []);

  const runSave = useCallback(async () => {
    if (!latestRef.current || savingRef.current) return;
    const payload = latestRef.current;
    latestRef.current = null;
    savingRef.current = true;
    if (mountedRef.current) setState('saving');
    try {
      await saveFn(payload);
      if (!mountedRef.current) return;
      setError(null);
      setState('saved');
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          // Only revert to idle if nothing new queued in the meantime.
          setState((s) => (s === 'saved' && !latestRef.current ? 'idle' : s));
        }
      }, savedIndicatorMs);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e);
      setState('error');
    } finally {
      savingRef.current = false;
      // If more changes queued during the save, kick another cycle.
      if (mountedRef.current && latestRef.current) {
        scheduleSave();
      }
    }
  }, [saveFn, savedIndicatorMs]);

  const scheduleSave = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      runSave();
    }, delay);
  }, [delay, runSave]);

  const trigger = useCallback((payload) => {
    latestRef.current = payload;
    if (mountedRef.current) {
      setState((s) => (s === 'saving' ? s : 'pending'));
    }
    scheduleSave();
  }, [scheduleSave]);

  const flush = useCallback(async () => {
    clearTimeout(timerRef.current);
    if (latestRef.current) {
      await runSave();
    }
  }, [runSave]);

  return { trigger, flush, state, error };
}
