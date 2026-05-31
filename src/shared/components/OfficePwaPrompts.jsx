// ─── OfficePwaPrompts ───
// Office/admin PWA affordances, rendered inside the admin shell:
//   • a thin offline strip when connectivity drops
//   • an install prompt — a one-tap button on Android/Chrome, or manual
//     Add-to-Home-Screen instructions on iOS Safari (which has no prompt)
//
// There is intentionally NO update toast: the office SW auto-updates, so
// deploys reach staff without a click (unlike the caregiver app).
//
// This component also re-injects the office manifest from per-org branding
// once `organizations.settings` is available — startup installs the default
// manifest; this upgrades it to the org's identity when one is configured.
//
// All icons are lucide-react components (no emoji glyphs, per UI rules).

import { useEffect } from 'react';
import { WifiOff, Download, Share, PlusSquare, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useOfficePwa } from '../../pwa/useOfficePwa';
import { installOfficeManifest, resolveOfficeBranding } from '../../pwa/officeManifest';
import s from './OfficePwaPrompts.module.css';

export function OfficePwaPrompts() {
  const { currentOrgSettings } = useApp();
  const { online, installAffordance, promptInstall, dismissInstall } = useOfficePwa();

  // Upgrade the install identity to per-org branding when settings load.
  // No-op today (org settings carry no branding block), so it cleanly falls
  // back to the Tremendous Care defaults — but ready for Phase D.
  useEffect(() => {
    if (!currentOrgSettings) return;
    installOfficeManifest({ branding: resolveOfficeBranding(currentOrgSettings) });
  }, [currentOrgSettings]);

  return (
    <>
      {!online && (
        <div className={s.offlineStrip} role="status">
          <WifiOff size={15} aria-hidden="true" />
          <span>You&rsquo;re offline — changes won&rsquo;t save until you reconnect.</span>
        </div>
      )}

      {installAffordance === 'button' && (
        <div className={s.toast} role="dialog" aria-label="Install app">
          <Download className={s.icon} size={22} aria-hidden="true" />
          <div className={s.body}>
            <div className={s.title}>Install the office app</div>
            <div className={s.text}>
              Add it to your home screen for one-tap access in its own window.
            </div>
            <div className={s.actions}>
              <button type="button" className={s.btn} onClick={promptInstall}>
                Install
              </button>
              <button type="button" className={s.dismiss} onClick={dismissInstall}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {installAffordance === 'ios-hint' && (
        <div className={s.toast} role="dialog" aria-label="Add to home screen">
          <Share className={s.icon} size={22} aria-hidden="true" />
          <div className={s.body}>
            <div className={s.title}>Add to your home screen</div>
            <div className={s.text}>
              Tap the Share button <Share size={13} aria-hidden="true" />, then choose
              {' '}<strong>Add to Home Screen</strong> <PlusSquare size={13} aria-hidden="true" />.
            </div>
          </div>
          <button
            type="button"
            className={s.close}
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
