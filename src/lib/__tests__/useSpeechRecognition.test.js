// Must set before importing react-dom.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect } from 'vitest';
import { createRoot } from 'react-dom/client';
import React, { act } from 'react';
import { useSpeechRecognition } from '../../shared/hooks/useSpeechRecognition';

/**
 * Mount a hook into a real jsdom node and expose its return value via a
 * ref — same pattern the carePlanAutosave tests use. No testing-library
 * dependency required.
 */
function mountHook(hookFn) {
  const result = {};
  const container = document.createElement('div');
  document.body.appendChild(container);
  function Harness() {
    result.current = hookFn();
    return null;
  }
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(Harness));
  });
  return {
    result,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useSpeechRecognition', () => {
  it('returns the expected hook API surface', () => {
    const { result, unmount } = mountHook(() => useSpeechRecognition());
    try {
      expect(typeof result.current.supported).toBe('boolean');
      expect(result.current.listening).toBe(false);
      expect(typeof result.current.toggle).toBe('function');
      expect(typeof result.current.stop).toBe('function');
    } finally {
      unmount();
    }
  });

  it('toggle is a no-op when SpeechRecognition is not available (jsdom default)', () => {
    const { result, unmount } = mountHook(() => useSpeechRecognition());
    try {
      // jsdom does not implement Web Speech API → supported should be false
      expect(result.current.supported).toBe(false);
      act(() => result.current.toggle());
      // listening flag stays false because the early-return path was taken
      expect(result.current.listening).toBe(false);
    } finally {
      unmount();
    }
  });

  it('stop is safe to call when nothing is running', () => {
    const { result, unmount } = mountHook(() => useSpeechRecognition());
    try {
      expect(() => act(() => result.current.stop())).not.toThrow();
      expect(result.current.listening).toBe(false);
    } finally {
      unmount();
    }
  });
});
