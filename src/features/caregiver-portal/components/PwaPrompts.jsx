// ─── PwaPrompts ───
// Caregiver-facing PWA affordances, rendered inside the caregiver shell:
//   • a persistent offline strip when the device loses connectivity
//   • a "new version available" update toast (prompt-based, never auto)
//   • an install prompt — a one-tap button on Android/Chrome, or manual
//     Add-to-Home-Screen instructions on iOS Safari (which has no prompt)
//
// All icons are lucide-react components (no emoji glyphs, per UI rules).

import { WifiOff, RefreshCw, Download, Share, PlusSquare, X } from 'lucide-react';
import { usePwa } from '../../../pwa/usePwa';
import s from '../CaregiverPortal.module.css';

export function PwaPrompts() {
  const {
    needRefresh,
    online,
    update,
    installAffordance,
    promptInstall,
    dismissInstall,
  } = usePwa();

  return (
    <>
      {!online && (
        <div className={s.offlineStrip} role="status">
          <WifiOff size={15} aria-hidden="true" />
          <span>You&rsquo;re offline — some actions may not work until you reconnect.</span>
        </div>
      )}

      {needRefresh && (
        <div className={s.pwaToast} role="alertdialog" aria-label="App update available">
          <RefreshCw className={s.pwaToastIcon} size={22} aria-hidden="true" />
          <div className={s.pwaToastBody}>
            <div className={s.pwaToastTitle}>Update available</div>
            <div className={s.pwaToastText}>A new version of the app is ready.</div>
            <div className={s.pwaToastActions}>
              <button type="button" className={s.pwaToastBtn} onClick={update}>
                Update now
              </button>
            </div>
          </div>
        </div>
      )}

      {!needRefresh && installAffordance === 'button' && (
        <div className={s.pwaToast} role="dialog" aria-label="Install app">
          <Download className={s.pwaToastIcon} size={22} aria-hidden="true" />
          <div className={s.pwaToastBody}>
            <div className={s.pwaToastTitle}>Install Tremendous Care</div>
            <div className={s.pwaToastText}>
              Add the app to your home screen for faster access and offline use.
            </div>
            <div className={s.pwaToastActions}>
              <button type="button" className={s.pwaToastBtn} onClick={promptInstall}>
                Install
              </button>
              <button type="button" className={s.pwaToastDismiss} onClick={dismissInstall}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {!needRefresh && installAffordance === 'ios-hint' && (
        <div className={s.pwaToast} role="dialog" aria-label="Add to home screen">
          <Share className={s.pwaToastIcon} size={22} aria-hidden="true" />
          <div className={s.pwaToastBody}>
            <div className={s.pwaToastTitle}>Add to your home screen</div>
            <div className={s.pwaToastText}>
              Tap the Share button <Share size={13} aria-hidden="true" />, then choose
              {' '}<strong>Add to Home Screen</strong> <PlusSquare size={13} aria-hidden="true" />.
            </div>
          </div>
          <button
            type="button"
            className={s.pwaToastClose}
            onClick={dismissInstall}
            aria-label="Dismiss"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}
