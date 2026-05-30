import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { SMSConversationView } from './SMSConversationView';
import { SMSComposeBar } from './SMSComposeBar';
import { EmailThreadView } from './EmailThreadView';
import { EmailComposeForm } from './EmailComposeForm';
import { CallLogView } from './CallLogView';
import styles from './messaging.module.css';

const CHANNELS = [
  { key: 'all', label: 'All' },
  { key: 'texts', label: 'Texts', icon: '💬' },
  { key: 'emails', label: 'Emails', icon: '✉️' },
  { key: 'calls', label: 'Calls', icon: '📞' },
];

/**
 * Messaging Center — top-level container for the Messages tab.
 * Shows channel filter tabs and renders the appropriate sub-view.
 *
 * Works for both caregivers and clients via the `entity` + `entityType`
 * props. The legacy `caregiver` prop is still accepted for backwards
 * compatibility with existing call sites.
 */
export function MessagingCenter({
  entity,
  entityType = 'caregiver',
  caregiver,
  smsMessages,
  emailMessages,
  callEntries,
  rcLoading,
  rcError,
  emailLoading,
  accessToken,
  currentUser,
  onAddNote,
  showToast,
}) {
  const recipient = entity || caregiver;
  const [activeChannel, setActiveChannel] = useState('texts');

  // RingCentral-sourced channels (texts, calls) share the rate-limit banner
  // so an empty list during a 429 reads as "throttled" not "no messages".
  const rcBanner = rcError ? (
    <div
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '10px 16px', color: '#D97706', fontSize: 13, fontWeight: 500,
      }}
    >
      <AlertTriangle size={13} strokeWidth={2} aria-hidden /> {rcError}
    </div>
  ) : null;

  const counts = {
    texts: smsMessages.length,
    emails: emailMessages.length,
    calls: callEntries.length,
    all: smsMessages.length + emailMessages.length + callEntries.length,
  };

  const renderContent = () => {
    if (rcLoading) {
      return (
        <div className={styles.loadingRow}>
          <span className={styles.spinner} />
          Loading communication history...
        </div>
      );
    }

    switch (activeChannel) {
      case 'texts':
        return (
          <>
            {rcBanner}
            <SMSConversationView messages={smsMessages} />
            <SMSComposeBar
              entity={recipient}
              entityType={entityType}
              currentUser={currentUser}
              showToast={showToast}
            />
          </>
        );

      case 'emails':
        return (
          <>
            {emailLoading && (
              <div className={styles.loadingRow}>
                <span className={styles.spinner} />
                Loading email history from Outlook...
              </div>
            )}
            <EmailThreadView emails={emailMessages} />
            <EmailComposeForm
              entity={recipient}
              entityType={entityType}
              currentUser={currentUser}
              onAddNote={onAddNote}
              showToast={showToast}
            />
          </>
        );

      case 'calls':
        return (
          <>
            {rcBanner}
            <CallLogView calls={callEntries} accessToken={accessToken} />
          </>
        );

      case 'all':
      default:
        // For "All", show SMS conversation as the primary view
        return (
          <>
            {rcBanner}
            <SMSConversationView messages={smsMessages} />
            <SMSComposeBar
              entity={recipient}
              entityType={entityType}
              currentUser={currentUser}
              showToast={showToast}
            />
          </>
        );
    }
  };

  return (
    <div className={styles.messagingContainer}>
      <div className={styles.messagingHeader}>
        <h3 className={styles.messagingTitle}>Messages</h3>
      </div>

      {/* Channel filter tabs */}
      <div className={styles.channelTabs}>
        {CHANNELS.map((ch) => (
          <button
            key={ch.key}
            className={`${styles.channelTab} ${activeChannel === ch.key ? styles.channelTabActive : ''}`}
            onClick={() => setActiveChannel(ch.key)}
          >
            {ch.icon && `${ch.icon} `}{ch.label}
            {counts[ch.key] > 0 && (
              <span className={styles.channelCount}>({counts[ch.key]})</span>
            )}
          </button>
        ))}
      </div>

      {renderContent()}
    </div>
  );
}
