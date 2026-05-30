// ─── usePwa ───
// React hook that wires up the caregiver PWA lifecycle:
//   • registers the service worker (scoped to /care, see vite.config.js)
//   • exposes a "new version available" signal + an update() action
//   • captures the Android/Chrome beforeinstallprompt for an install button
//   • tracks online/offline so the UI can warn caregivers in the field
//
// Update strategy is prompt-based: registerSW(onNeedRefresh) fires when a
// new SW is waiting; calling update() skip-waits and reloads. Nothing is
// swapped out from under the caregiver mid-shift.

import { useEffect, useRef, useState, useCallback } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { isStandalone, isIos, installAffordance } from './pwaEnv';

export function usePwa() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [installEvent, setInstallEvent] = useState(null);
  const [installDismissed, setInstallDismissed] = useState(false);
  const updateSWRef = useRef(null);

  // Register the service worker once.
  useEffect(() => {
    updateSWRef.current = registerSW({
      immediate: true,
      onNeedRefresh() {
        setNeedRefresh(true);
      },
      onOfflineReady() {
        setOfflineReady(true);
      },
      onRegisterError(err) {
        // Non-fatal: the app still works online without the SW.
        console.error('[pwa] SW registration failed:', err);
      },
    });
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

  const update = useCallback(() => {
    setNeedRefresh(false);
    updateSWRef.current?.(true);
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
    needRefresh,
    offlineReady,
    online,
    update,
    installAffordance: affordance,
    promptInstall,
    dismissInstall,
  };
}
