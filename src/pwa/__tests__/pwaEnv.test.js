import { describe, it, expect } from 'vitest';
import { isStandalone, isIos, installAffordance } from '../pwaEnv';

describe('isStandalone', () => {
  const mm = (matches) => () => ({ matches });

  it('is true when display-mode standalone matches', () => {
    expect(isStandalone({ matchMedia: mm(true) })).toBe(true);
  });

  it('is true for iOS navigator.standalone', () => {
    expect(isStandalone({ navigator: { standalone: true } })).toBe(true);
  });

  it('is false in a normal browser tab', () => {
    expect(isStandalone({ matchMedia: mm(false), navigator: { standalone: false } })).toBe(false);
  });

  it('does not throw when matchMedia throws', () => {
    const throwing = () => {
      throw new Error('bad query');
    };
    expect(isStandalone({ matchMedia: throwing })).toBe(false);
  });

  it('is false with no environment provided', () => {
    expect(isStandalone()).toBe(false);
  });
});

describe('isIos', () => {
  it('detects iPhone/iPad/iPod UAs', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true);
    expect(isIos('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)')).toBe(true);
  });

  it('detects iPadOS masquerading as macOS via touch points', () => {
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { maxTouchPoints: 5 })).toBe(true);
  });

  it('is false for a real Mac (no touch)', () => {
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { maxTouchPoints: 0 })).toBe(false);
  });

  it('is false for Android', () => {
    expect(isIos('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(false);
  });

  it('handles missing UA gracefully', () => {
    expect(isIos()).toBe(false);
  });
});

describe('installAffordance', () => {
  it('shows nothing when already installed', () => {
    expect(installAffordance({ standalone: true, hasInstallPrompt: true, ios: true })).toBe('none');
  });

  it('shows nothing once dismissed', () => {
    expect(installAffordance({ hasInstallPrompt: true, dismissed: true })).toBe('none');
  });

  it('shows the install button when a prompt is available', () => {
    expect(installAffordance({ hasInstallPrompt: true })).toBe('button');
  });

  it('shows the iOS hint when on iOS with no prompt', () => {
    expect(installAffordance({ ios: true, hasInstallPrompt: false })).toBe('ios-hint');
  });

  it('prefers the button over the iOS hint when both could apply', () => {
    expect(installAffordance({ ios: true, hasInstallPrompt: true })).toBe('button');
  });

  it('shows nothing on an unsupported desktop browser', () => {
    expect(installAffordance({ ios: false, hasInstallPrompt: false })).toBe('none');
  });
});
