// ─── useOfficePwa ───
// Office/admin PWA lifecycle. Mirrors the caregiver `usePwa` hook but is
// intentionally simpler:
//   • registers the minimal office service worker (public/app-sw.js, scope /)
//   • captures the Android/Chrome beforeinstallprompt for an install button
//   • tracks online/offline for a subtle field-warning strip
//
// Crucially there is NO update prompt here. The office SW is network-first
// and auto-activates new versions (skipWaiting), so deploys flow to staff
// automatically — unlike the caregiver app, which freezes until "Update".
//
// Registration is manual via navigator.serviceWorker (the caregiver app owns
// the vite-plugin-pwa `virtual:pwa-register` SW at /care; this surface uses a
// separate, hand-written SW so the two never interfere).

import { useEffect, useState, useCallback } from 'react';
import { isStandalone, isIos, installAffordance } from './pwaEnv';

export function useOfficePwa() {
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [installEvent, setInstallEvent] = useState(null);
  const [installDismissed, setInstallDismissed] = useState(false);

  // Register the office service worker once. Non-fatal on failure: the app
  // works fine online without it.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // Only in production builds — `npm run dev` should never install a SW.
    if (!import.meta.env.PROD) return;
    navigator.serviceWorker
      .register('/app-sw.js', { scope: '/' })
      .catch((err) => console.error('[office-pwa] SW registration failed:', err));
  }, []);

  // Online/offline tracking.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Capture the install prompt (Android/Chrome). iOS never fires this.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onBeforeInstall = (e) => {
      e.preventDefault();
      setInstallEvent(e);
    };
    const onInstalled = () => {
      setInstallEvent(null);
      setInstallDismissed(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!installEvent) return false;
    installEvent.prompt();
    const choice = await installEvent.userChoice;
    setInstallEvent(null);
    if (choice?.outcome !== 'accepted') setInstallDismissed(true);
    return choice?.outcome === 'accepted';
  }, [installEvent]);

  const dismissInstall = useCallback(() => setInstallDismissed(true), []);

  const standalone = isStandalone({
    matchMedia: typeof window !== 'undefined' ? window.matchMedia : undefined,
    navigator: typeof navigator !== 'undefined' ? navigator : undefined,
  });
  const ios = isIos(
    typeof navigator !== 'undefined' ? navigator.userAgent : '',
    { maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0 },
  );
  const affordance = installAffordance({
    standalone,
    hasInstallPrompt: Boolean(installEvent),
    ios,
    dismissed: installDismissed,
  });

  return {
    online,
    installAffordance: affordance,
    promptInstall,
    dismissInstall,
  };
}
