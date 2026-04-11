import { useState } from 'react';
import { groupEmailsByThread, extractBodyFromText } from './emailUtils';
import styles from './messaging.module.css';

/**
 * Format a timestamp for display in thread list and message headers.
 */
function formatTimestamp(ts) {
  const date = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today - msgDay) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format a full date + time for expanded message view.
 */
function formatFullTimestamp(ts) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Get a short preview of email body text.
 */
function getPreview(email) {
  const body = email.fullBody || extractBodyFromText(email.text) || '';
  if (body.length <= 120) return body;
  return body.substring(0, 120).trim() + '...';
}

/**
 * Email thread view — groups emails by subject, shows expandable thread cards.
 */
export function EmailThreadView({ emails }) {
  const [expandedThread, setExpandedThread] = useState(null);

  const threads = groupEmailsByThread(emails);

  if (threads.length === 0) {
    return (
      <div className={styles.chatContainer}>
        <div className={styles.chatEmpty}>
          <span className={styles.chatEmptyIcon}>✉️</span>
          <div>No emails yet</div>
        </div>
      </div>
    );
  }

  const toggleThread = (key) => {
    setExpandedThread(expandedThread === key ? null : key);
  };

  return (
    <div className={styles.emailContainer}>
      {threads.map((thread) => {
        const isExpanded = expandedThread === thread.normalizedKey;
        const lastMsg = thread.messages[thread.messages.length - 1];
        const lastDirection = lastMsg.direction;

        return (
          <div key={thread.normalizedKey} className={styles.emailThread}>
            {/* Thread header — clickable to expand */}
            <button
              className={`${styles.emailThreadHeader} ${isExpanded ? styles.emailThreadHeaderExpanded : ''}`}
              onClick={() => toggleThread(thread.normalizedKey)}
            >
              <div className={styles.emailThreadLeft}>
                <div className={styles.emailThreadSubject}>
                  {lastDirection === 'inbound' && (
                    <span className={styles.emailDirectionBadgeInbound}>In</span>
                  )}
                  {thread.subject}
                </div>
                <div className={styles.emailThreadPreview}>
                  {getPreview(lastMsg)}
                </div>
              </div>
              <div className={styles.emailThreadRight}>
                <span className={styles.emailThreadTime}>
                  {formatTimestamp(thread.lastTimestamp)}
                </span>
                {thread.messages.length > 1 && (
                  <span className={styles.emailThreadCount}>
                    {thread.messages.length}
                  </span>
                )}
                <span className={styles.emailThreadChevron}>
                  {isExpanded ? '▾' : '▸'}
                </span>
              </div>
            </button>

            {/* Expanded thread — show all messages */}
            {isExpanded && (
              <div className={styles.emailThreadBody}>
                {thread.messages.map((email, i) => (
                  <div key={email.id || `email-${i}`} className={styles.emailMessage}>
                    <div className={styles.emailMessageHeader}>
                      <div className={styles.emailMessageMeta}>
                        <span className={
                          email.direction === 'inbound'
                            ? styles.emailDirectionBadgeInbound
                            : styles.emailDirectionBadgeOutbound
                        }>
                          {email.direction === 'inbound' ? 'Received' : 'Sent'}
                        </span>
                        {email.author && (
                          <span className={styles.emailMessageAuthor}>{email.author}</span>
                        )}
                        {email.outcome && (
                          <span className={styles.emailMessageRecipient}>{email.outcome}</span>
                        )}
                      </div>
                      <span className={styles.emailMessageTime}>
                        {formatFullTimestamp(email.timestamp)}
                      </span>
                    </div>
                    <div className={styles.emailMessageBody}>
                      {email.fullBody || extractBodyFromText(email.text) || email.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
