// ─────────────────────────────────────────────────────────────────
// Voice / CTI Phase 1 PR 3 — ActiveCallBar
//
// Persistent floating bar at the bottom of the screen during an
// active call (status='answered'). Shows duration counter, caller
// identity, and a profile-jump link. Audio controls are not in
// this PR — they require the RingCentral WebPhone SDK (PR 4+).
//
// Renders nothing when there's no answered call.
// ─────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVoice } from '../../shared/context/VoiceContext';
import { shouldShowActiveBar } from '../../lib/voice/callPopReducer';
import styles from './voice.module.css';

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatPhone(e164) {
  if (!e164) return '';
  const digits = String(e164).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return e164;
}

export function ActiveCallBar() {
  const navigate = useNavigate();
  const { activeCall } = useVoice();
  const [tick, setTick] = useState(0);

  // Tick once a second to keep the duration counter alive.
  useEffect(() => {
    if (!activeCall || activeCall.status !== 'answered') return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [activeCall]);

  if (!shouldShowActiveBar({ activeCall, recentlyEnded: null })) return null;

  const call = activeCall;
  const remotePhone = call.direction === 'inbound' ? call.fromE164 : call.toE164;
  const headline = call.matchedEntityName || formatPhone(remotePhone) || 'Unknown caller';

  let durationSec = 0;
  if (call.answeredAt) {
    durationSec = Math.floor((Date.now() - Date.parse(call.answeredAt)) / 1000);
  } else if (call.durationSeconds) {
    durationSec = call.durationSeconds;
  }
  void tick; // referenced to opt into the re-render

  const canOpen = !!call.matchedEntityType && !!call.matchedEntityId;

  const handleOpenProfile = () => {
    if (!canOpen) return;
    if (call.matchedEntityType === 'client') {
      navigate(`/clients/${call.matchedEntityId}`);
    } else {
      navigate(`/caregiver/${call.matchedEntityId}`);
    }
  };

  return (
    <div className={styles.activeBar} role="status" aria-live="polite">
      <span className={styles.activeDot} aria-hidden="true" />
      <span className={styles.activeName}>{headline}</span>
      <span className={styles.activeDuration}>{formatDuration(durationSec)}</span>
      {canOpen && (
        <button type="button" className={styles.linkBtn} onClick={handleOpenProfile}>
          Open profile
        </button>
      )}
    </div>
  );
}
