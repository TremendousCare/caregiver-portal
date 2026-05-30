// ─── PWA environment helpers ───
// Pure functions for detecting install state and platform, kept separate
// from the React hook so they can be unit-tested without a DOM. iOS Safari
// does not fire `beforeinstallprompt`, so the caregiver app shows a manual
// "Add to Home Screen" hint there instead of an install button.

// True when the app is already running as an installed PWA (standalone).
// Covers the standard display-mode media query plus the iOS-only
// `navigator.standalone` flag.
export function isStandalone({ matchMedia, navigator: nav } = {}) {
  if (matchMedia) {
    try {
      if (matchMedia('(display-mode: standalone)')?.matches) return true;
      if (matchMedia('(display-mode: fullscreen)')?.matches) return true;
    } catch {
      // matchMedia can throw on malformed queries in old engines — ignore.
    }
  }
  if (nav && nav.standalone === true) return true;
  return false;
}

// True for iOS Safari (iPhone/iPad), where install is manual. iPadOS 13+
// reports a Mac UA but exposes touch points, so we check for that too.
export function isIos(userAgent = '', { maxTouchPoints = 0 } = {}) {
  const ua = String(userAgent);
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS masquerading as macOS.
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return true;
  return false;
}

// Decide which install affordance (if any) to surface.
//   'none'    — already installed, or dismissed
//   'button'  — a beforeinstallprompt event is available (Android/Chrome)
//   'ios-hint'— iOS Safari: show manual Add-to-Home-Screen instructions
export function installAffordance({
  standalone,
  hasInstallPrompt,
  ios,
  dismissed,
} = {}) {
  if (standalone) return 'none';
  if (dismissed) return 'none';
  if (hasInstallPrompt) return 'button';
  if (ios) return 'ios-hint';
  return 'none';
}
