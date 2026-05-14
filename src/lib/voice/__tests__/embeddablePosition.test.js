/**
 * Tests for src/lib/voice/embeddablePosition.js — the load / store /
 * clamp helpers for the draggable RingCentral Embeddable widget.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  STORAGE_KEY,
  clampPosition,
  loadStoredPosition,
  storePosition,
} from '../embeddablePosition';

function makeMemoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _data: data,
  };
}

describe('loadStoredPosition', () => {
  let storage;
  beforeEach(() => {
    storage = makeMemoryStorage();
  });

  it('returns null when nothing is stored', () => {
    expect(loadStoredPosition(storage)).toBeNull();
  });

  it('returns the stored {left, top} when present', () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ left: 120, top: 80 }));
    expect(loadStoredPosition(storage)).toEqual({ left: 120, top: 80 });
  });

  it('returns null for malformed JSON', () => {
    storage.setItem(STORAGE_KEY, 'not-json');
    expect(loadStoredPosition(storage)).toBeNull();
  });

  it('returns null when fields are not finite numbers', () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ left: 'nope', top: 0 }));
    expect(loadStoredPosition(storage)).toBeNull();
  });

  it('strips extra fields, returning only left and top', () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ left: 10, top: 20, extra: 'ignored' }),
    );
    expect(loadStoredPosition(storage)).toEqual({ left: 10, top: 20 });
  });
});

describe('storePosition', () => {
  let storage;
  beforeEach(() => {
    storage = makeMemoryStorage();
  });

  it('writes the position as JSON', () => {
    storePosition({ left: 50, top: 75 }, storage);
    expect(JSON.parse(storage.getItem(STORAGE_KEY))).toEqual({
      left: 50,
      top: 75,
    });
  });

  it('removes the key when called with null', () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ left: 0, top: 0 }));
    storePosition(null, storage);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('ignores invalid positions instead of writing garbage', () => {
    storePosition({ left: 'oops', top: 5 }, storage);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('swallows storage errors (e.g. quota exceeded)', () => {
    const throwingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => {},
    };
    expect(() =>
      storePosition({ left: 1, top: 2 }, throwingStorage),
    ).not.toThrow();
  });
});

describe('clampPosition', () => {
  const viewport = { width: 1280, height: 800 };
  const panel = { width: 320, height: 560 };

  it('returns the same position when it is fully on-screen', () => {
    expect(
      clampPosition({ left: 200, top: 100 }, viewport, panel),
    ).toEqual({ left: 200, top: 100 });
  });

  it('clamps to the right edge so at least 80px of the panel stays visible', () => {
    const clamped = clampPosition({ left: 2000, top: 50 }, viewport, panel);
    expect(clamped.left).toBe(viewport.width - 80);
  });

  it('clamps to the left edge so at least 80px of the panel stays visible', () => {
    const clamped = clampPosition({ left: -1000, top: 50 }, viewport, panel);
    expect(clamped.left).toBe(80 - panel.width);
  });

  it('clamps to the top of the viewport (no negative top)', () => {
    const clamped = clampPosition({ left: 200, top: -500 }, viewport, panel);
    expect(clamped.top).toBe(0);
  });

  it('clamps to the bottom of the viewport leaving 80px header reachable', () => {
    const clamped = clampPosition({ left: 200, top: 5000 }, viewport, panel);
    expect(clamped.top).toBe(viewport.height - 80);
  });

  it('returns the input untouched when it is not a finite position', () => {
    expect(clampPosition(null, viewport, panel)).toBeNull();
    expect(clampPosition({ left: NaN, top: 0 }, viewport, panel)).toEqual({
      left: NaN,
      top: 0,
    });
  });
});
