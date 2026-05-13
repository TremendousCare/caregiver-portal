// ─────────────────────────────────────────────────────────────────
// Voice / CTI Phase 2 — PhoneCallButton
//
// Click-to-call button. Wraps any phone number; clicking it sends
// the number to the RingCentral Embeddable widget which expands the
// dialer panel and places the call via WebRTC (user signed in to
// Embeddable) or RingOut (user signed in to RC but not VoIP).
//
// Renders nothing if the widget hasn't been mounted yet (e.g., the
// user has no bound extension, or Vite env var missing). Falls back
// gracefully — never throws.
// ─────────────────────────────────────────────────────────────────

import { useCallback, useState } from 'react';
import { useVoice } from '../../shared/context/VoiceContext';
import styles from './voice.module.css';

export function PhoneCallButton({ phone, label = 'Call', compact = false }) {
  const { placeCall, hasDialer } = useVoice();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleClick = useCallback(async () => {
    if (!phone || busy) return;
    setBusy(true);
    setError(null);
    const result = await placeCall(phone);
    setBusy(false);
    if (!result.success) {
      setError(result.error || 'Call failed');
      setTimeout(() => setError(null), 4000);
    }
  }, [phone, busy, placeCall]);

  if (!hasDialer) return null;

  return (
    <button
      type="button"
      className={styles.phoneCallBtn}
      onClick={handleClick}
      disabled={!phone || busy}
      title={error || `Call ${phone}`}
      aria-busy={busy}
    >
      <span>{busy ? 'Dialing…' : error ? 'Failed' : compact ? 'Call' : label}</span>
    </button>
  );
}
