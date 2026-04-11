import { useEffect, useRef } from 'react';
import styles from './messaging.module.css';

/**
 * Format a date for the date separator labels.
 * Returns "Today", "Yesterday", or "Mon, Mar 15" style.
 */
function formatDateLabel(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today - messageDay) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Format time for individual message timestamps.
 */
function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Check if two timestamps fall on different calendar days.
 */
function isDifferentDay(ts1, ts2) {
  const d1 = new Date(ts1);
  const d2 = new Date(ts2);
  return d1.getFullYear() !== d2.getFullYear()
    || d1.getMonth() !== d2.getMonth()
    || d1.getDate() !== d2.getDate();
}

/**
 * Chat-bubble view for SMS messages.
 * Outbound messages aligned right (navy), inbound aligned left (white).
 */
export function SMSConversationView({ messages }) {
  const scrollRef = useRef(null);

  // Auto-scroll to bottom on mount and when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className={styles.chatContainer}>
        <div className={styles.chatEmpty}>
          <span className={styles.chatEmptyIcon}>💬</span>
          <div>No text messages yet</div>
          <div style={{ fontSize: 12 }}>Send the first message using the box below</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.chatContainer} ref={scrollRef}>
      {messages.map((msg, i) => {
        const isOutbound = msg.direction === 'outbound';
        const showDateSeparator = i === 0 || isDifferentDay(messages[i - 1].timestamp, msg.timestamp);

        // Determine author display — skip generic system labels
        const author = msg.author && msg.author !== 'SMS Webhook' && msg.author !== 'system'
          ? msg.author
          : null;

        return (
          <div key={msg.id || `sms-${i}`}>
            {showDateSeparator && (
              <div className={styles.dateSeparator}>
                {formatDateLabel(msg.timestamp)}
              </div>
            )}
            <div className={`${styles.bubbleRow} ${isOutbound ? styles.bubbleRowOutbound : styles.bubbleRowInbound}`}>
              <div className={styles.bubbleWrapper}>
                <div className={`${styles.bubble} ${isOutbound ? styles.bubbleOutbound : styles.bubbleInbound}`}>
                  {msg.text}
                </div>
                <div className={`${styles.bubbleMeta} ${isOutbound ? styles.bubbleMetaOutbound : styles.bubbleMetaInbound}`}>
                  <span>{formatTime(msg.timestamp)}</span>
                  {isOutbound && author && <span className={styles.bubbleAuthor}>{author}</span>}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
