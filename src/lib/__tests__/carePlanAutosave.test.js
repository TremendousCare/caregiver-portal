// Must set before importing react-dom.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import React, { act } from 'react';
import { useAutosave } from '../../features/care-plans/useAutosave';

// ═══════════════════════════════════════════════════════════════
// useAutosave tests
//
// No React Testing Library — we render a tiny harness into a real
// DOM node (jsdom) and expose the hook's return value via a ref.
// Debouncing is tested with vi.useFakeTimers().
// ═══════════════════════════════════════════════════════════════

function mountHook(saveFn, options) {
  const result = {};
  const container = document.createElement('div');
  document.body.appendChild(container);

  function Harness() {
    const api = useAutosave(saveFn, options);
    result.current = api;
    return null;
  }

  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(Harness));
  });

  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };

  return { result, unmount };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutosave', () => {
  it('starts in idle state', () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = mountHook(saveFn);
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
    unmount();
  });

  it('goes idle → pending → saving → saved on trigger', async () => {
    let resolveSave;
    const saveFn = vi.fn(() => new Promise((r) => { resolveSave = r; }));
    const { result, unmount } = mountHook(saveFn, { delay: 1000, savedIndicatorMs: 500 });

    act(() => result.current.trigger({ a: 1 }));
    expect(result.current.state).toBe('pending');

    // Fast-forward the debounce timer
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith({ a: 1 });
    expect(result.current.state).toBe('saving');

    // Resolve the save promise
    await act(async () => {
      resolveSave();
      await Promise.resolve();
    });
    expect(result.current.state).toBe('saved');

    // After savedIndicatorMs, state reverts to idle
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.state).toBe('idle');

    unmount();
  });

  it('debounces rapid changes into one save call', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = mountHook(saveFn, { delay: 1000 });

    act(() => result.current.trigger({ v: 1 }));
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current.trigger({ v: 2 }));
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current.trigger({ v: 3 }));

    // Still pending — 400ms since the last trigger.
    expect(saveFn).not.toHaveBeenCalled();

    // Finish the debounce window.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith({ v: 3 });

    unmount();
  });

  it('transitions to error state when saveFn rejects', async () => {
    const err = new Error('boom');
    const saveFn = vi.fn().mockRejectedValue(err);
    const { result, unmount } = mountHook(saveFn, { delay: 100 });

    act(() => result.current.trigger({ a: 1 }));

    await act(async () => {
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe(err);

    unmount();
  });

  it('does not fire save on unmount if already running', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = mountHook(saveFn, { delay: 100 });

    act(() => result.current.trigger({ a: 1 }));
    unmount();

    // Advance past the debounce — after unmount the save should not fire.
    act(() => vi.advanceTimersByTime(500));
    expect(saveFn).not.toHaveBeenCalled();
  });

  it('flush runs the pending save immediately', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = mountHook(saveFn, { delay: 10000 });

    act(() => result.current.trigger({ a: 1 }));
    expect(saveFn).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.flush();
    });

    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith({ a: 1 });

    unmount();
  });

  it('queues a new save if triggered during an in-flight save', async () => {
    let resolveFirst;
    const saveFn = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValue(undefined);

    const { result, unmount } = mountHook(saveFn, { delay: 100, savedIndicatorMs: 50 });

    act(() => result.current.trigger({ v: 1 }));
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('saving');

    // Trigger another change while the first save is still pending.
    act(() => result.current.trigger({ v: 2 }));

    // Resolve the first save.
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Second save fires with the queued payload.
    expect(saveFn).toHaveBeenCalledTimes(2);
    expect(saveFn).toHaveBeenNthCalledWith(2, { v: 2 });

    unmount();
  });
});
