import { useState } from 'react';
import { SMSConversationView } from './SMSConversationView';
import { SMSComposeBar } from './SMSComposeBar';
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
 * Phase 1: SMS conversation view + inline reply
 * Phase 2: Email thread view (coming soon)
 * Phase 3: Call log view (coming soon)
 */
export function MessagingCenter({
  caregiver,
  smsMessages,
  emailMessages,
  callEntries,
  rcLoading,
  currentUser,
  onAddNote,
  showToast,
}) {
  const [activeChannel, setActiveChannel] = useState('texts');

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
            <SMSConversationView messages={smsMessages} />
            <SMSComposeBar
              caregiver={caregiver}
              currentUser={currentUser}
              onAddNote={onAddNote}
              showToast={showToast}
            />
          </>
        );

      case 'emails':
        return (
          <div className={styles.chatContainer}>
            <div className={styles.chatEmpty}>
              <span className={styles.chatEmptyIcon}>✉️</span>
              <div>{emailMessages.length === 0 ? 'No emails yet' : `${emailMessages.length} email${emailMessages.length !== 1 ? 's' : ''}`}</div>
              <div style={{ fontSize: 12 }}>Email thread view coming soon</div>
            </div>
          </div>
        );

      case 'calls':
        return (
          <div className={styles.chatContainer}>
            <div className={styles.chatEmpty}>
              <span className={styles.chatEmptyIcon}>📞</span>
              <div>{callEntries.length === 0 ? 'No call records yet' : `${callEntries.length} call${callEntries.length !== 1 ? 's' : ''}`}</div>
              <div style={{ fontSize: 12 }}>Call log view coming soon</div>
            </div>
          </div>
        );

      case 'all':
      default:
        // For "All", show SMS conversation as the primary view
        return (
          <>
            <SMSConversationView messages={smsMessages} />
            <SMSComposeBar
              caregiver={caregiver}
              currentUser={currentUser}
              onAddNote={onAddNote}
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
