// ─────────────────────────────────────────────────────────────────
// Voice / CTI Phase 1 PR 3 — IncomingCallToast
//
// Non-blocking screen-pop. Top-right corner, sits above page content
// at the same z-index as the global Toast (9999). User can open the
// caller's profile or dismiss; doesn't yank them out of their work.
//
// Mounted at the admin shell root so it's visible on every page.
// Renders nothing when there's no active call AND no recently-ended
// flash; CSS pop animation matches the existing Toast feel.
// ─────────────────────────────────────────────────────────────────

import { useNavigate } from 'react-router-dom';
import { useVoice } from '../../shared/context/VoiceContext';
import { shouldShowToast } from '../../lib/voice/callPopReducer';
import styles from './voice.module.css';

function formatPhone(e164) {
  if (!e164) return 'Unknown';
  const digits = String(e164).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return e164;
}

function statusBadge(call) {
  switch (call.status) {
    case 'ringing':
      return { text: call.direction === 'outbound' ? 'Calling…' : 'Ringing', tone: 'info' };
    case 'answered':
      return { text: 'On call', tone: 'success' };
    case 'voicemail':
      return { text: 'Voicemail', tone: 'muted' };
    case 'missed':
      return { text: 'Missed', tone: 'warn' };
    case 'ended':
      return { text: 'Call ended', tone: 'muted' };
    default:
      return { text: call.status, tone: 'muted' };
  }
}

export function IncomingCallToast() {
  const navigate = useNavigate();
  const { activeCall, recentlyEnded, dismissActive } = useVoice();

  const state = { activeCall, recentlyEnded };
  if (!shouldShowToast(state)) return null;

  const call = activeCall && !activeCall.dismissed ? activeCall : recentlyEnded;
  if (!call) return null;

  const badge = statusBadge(call);
  const remotePhone =
    call.direction === 'inbound' ? call.fromE164 : call.toE164;
  const headline = call.matchedEntityName || formatPhone(remotePhone);
  const subline = call.matchedEntityName
    ? formatPhone(remotePhone)
    : 'Unknown caller';

  const handleOpenProfile = () => {
    if (!call.matchedEntityType || !call.matchedEntityId) return;
    if (call.matchedEntityType === 'client') {
      navigate(`/clients/${call.matchedEntityId}`);
    } else {
      navigate(`/caregiver/${call.matchedEntityId}`);
    }
    dismissActive();
  };

  const canOpen = !!call.matchedEntityType && !!call.matchedEntityId;

  return (
    <div className={styles.popCard} role="status" aria-live="polite">
      <div className={styles.popHeader}>
        <span className={`${styles.badge} ${styles[`badge_${badge.tone}`]}`}>
          {badge.text}
        </span>
        <button
          type="button"
          className={styles.dismissBtn}
          onClick={dismissActive}
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      <div className={styles.popHeadline}>{headline}</div>
      <div className={styles.popSubline}>{subline}</div>
      {call.matchedEntityType && (
        <div className={styles.popMeta}>
          {call.matchedEntityType === 'client' ? 'Client' : 'Caregiver'}
        </div>
      )}
      <div className={styles.popActions}>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={handleOpenProfile}
          disabled={!canOpen}
        >
          {canOpen ? 'Open profile' : 'Unknown caller'}
        </button>
      </div>
    </div>
  );
}
