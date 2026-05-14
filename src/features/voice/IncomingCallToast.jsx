// ─────────────────────────────────────────────────────────────────
// Voice / CTI — IncomingCallToast
//
// Non-blocking screen-pop. Top-right corner, sits above page content
// at the same z-index as the global Toast (9999). User can:
//   - Answer the call (inbound + ringing only) — fires an
//     `rc-adapter-control-call` postMessage into the hidden
//     Embeddable iframe and asks ToolsFAB to surface the dialer.
//   - Dismiss the toast (call keeps ringing through RC's routing —
//     this is intentional; Decline=voicemail UX is too surprising
//     given the existing forwarding rules).
//   - Open the matched caregiver/client profile.
//
// Mounted at the admin shell root so it's visible on every page.
// Renders nothing when there's no active call AND no recently-ended
// flash.
// ─────────────────────────────────────────────────────────────────

import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, X } from 'lucide-react';
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
  const {
    activeCall,
    recentlyEnded,
    dismissActive,
    answerCall,
    hasDialer,
  } = useVoice();
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState(null);

  const state = { activeCall, recentlyEnded };
  const visible = shouldShowToast(state);
  const call = activeCall && !activeCall.dismissed ? activeCall : recentlyEnded;

  const handleAnswer = useCallback(async () => {
    if (answering) return;
    setAnswering(true);
    setAnswerError(null);
    const result = await answerCall();
    setAnswering(false);
    if (!result.success) {
      setAnswerError(result.error || 'Answer failed');
      setTimeout(() => setAnswerError(null), 4000);
    }
  }, [answerCall, answering]);

  if (!visible || !call) return null;

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
  // Answer is only meaningful for an inbound call that's still
  // ringing. After answer or during outbound, we hide it.
  const showAnswer = call.direction === 'inbound' && call.status === 'ringing';
  const answerDisabled = !hasDialer || answering;
  const answerTitle = !hasDialer
    ? 'Sign in to the RingCentral widget first to answer from here'
    : answering
      ? 'Answering…'
      : 'Answer call';

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
      {showAnswer && (
        <div className={styles.popCallActions}>
          <button
            type="button"
            className={styles.answerBtn}
            onClick={handleAnswer}
            disabled={answerDisabled}
            title={answerTitle}
            aria-label="Answer call"
          >
            <Phone size={16} />
            <span>{answering ? 'Answering…' : 'Answer'}</span>
          </button>
          <button
            type="button"
            className={styles.declineBtn}
            onClick={dismissActive}
            aria-label="Dismiss toast"
            title="Dismiss this notification (call keeps ringing through RingCentral routing)"
          >
            <X size={16} />
            <span>Dismiss</span>
          </button>
        </div>
      )}
      {answerError && (
        <div className={styles.popError} role="alert">
          {answerError}
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
