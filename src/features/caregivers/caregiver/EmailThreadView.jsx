import { useState, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
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
 * Get the display body for an email message.
 * For portal notes: uses fullBody or extracts from text.
 * For Outlook emails: uses fullBody (loaded via get_email_thread) or falls back to preview.
 */
function getDisplayBody(email) {
  if (email.fullBody) return email.fullBody;
  if (email.source === 'outlook') return email.text ? extractBodyFromText(email.text) : '(Loading...)';
  return extractBodyFromText(email.text) || email.text;
}

/**
 * Email thread view — groups emails by subject, shows expandable thread cards.
 * Lazy-loads full email bodies from Outlook when a thread is expanded.
 */
export function EmailThreadView({ emails }) {
  const [expandedThread, setExpandedThread] = useState(null);
  const [threadBodies, setThreadBodies] = useState({}); // { conversationId: [emails with full bodies] }
  const [loadingThread, setLoadingThread] = useState(null);

  const threads = groupEmailsByThread(emails);

  // Fetch full email thread from Outlook when expanding a thread with Outlook-sourced messages
  const fetchThreadBodies = useCallback(async (thread) => {
    // Find a conversationId from any Outlook-sourced message in this thread
    const outlookMsg = thread.messages.find((m) => m.source === 'outlook' && m.conversationId);
    if (!outlookMsg || !supabase) return;

    // Already loaded
    if (threadBodies[outlookMsg.conversationId]) return;

    setLoadingThread(thread.normalizedKey);
    try {
      const { data, error } = await supabase.functions.invoke('outlook-integration', {
        body: {
          action: 'get_email_thread',
          conversation_id: outlookMsg.conversationId,
        },
      });

      if (error || !data || !data.emails) {
        console.warn('Thread fetch failed:', error);
        return;
      }

      // Build a map of full bodies keyed by date (for matching back to our messages)
      const bodies = {};
      for (const e of data.emails) {
        // Use the email body, stripping excessive length
        const body = e.body && e.body.length > 5000
          ? e.body.substring(0, 5000) + '\n\n... (truncated)'
          : e.body || '';
        const key = new Date(e.date).getTime();
        bodies[key] = {
          fullBody: body,
          from: e.from,
          fromName: e.from_name,
          to: e.to,
          cc: e.cc,
          subject: e.subject,
        };
      }

      setThreadBodies((prev) => ({ ...prev, [outlookMsg.conversationId]: bodies }));
    } catch (err) {
      console.warn('Thread fetch error:', err);
    } finally {
      setLoadingThread(null);
    }
  }, [threadBodies]);

  /**
   * Resolve the full body for an Outlook-sourced email.
   * Tries to match by timestamp against the loaded thread data.
   */
  const resolveBody = (email) => {
    if (email.fullBody) return email.fullBody;
    if (email.source !== 'outlook' || !email.conversationId) return getDisplayBody(email);

    const bodies = threadBodies[email.conversationId];
    if (!bodies) return getDisplayBody(email);

    // Match by closest timestamp (within 60 seconds)
    const emailTime = new Date(email.timestamp).getTime();
    for (const [key, data] of Object.entries(bodies)) {
      if (Math.abs(Number(key) - emailTime) < 60000) {
        return data.fullBody;
      }
    }

    return getDisplayBody(email);
  };

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

  const toggleThread = (thread) => {
    const key = thread.normalizedKey;
    if (expandedThread === key) {
      setExpandedThread(null);
    } else {
      setExpandedThread(key);
      // Lazy-load full bodies for Outlook-sourced threads
      const hasOutlook = thread.messages.some((m) => m.source === 'outlook' && !m.fullBody);
      if (hasOutlook) {
        fetchThreadBodies(thread);
      }
    }
  };

  return (
    <div className={styles.emailContainer}>
      {threads.map((thread) => {
        const isExpanded = expandedThread === thread.normalizedKey;
        const lastMsg = thread.messages[thread.messages.length - 1];
        const lastDirection = lastMsg.direction;
        const hasAttachments = thread.messages.some((m) => m.hasAttachments);
        const isLoadingThis = loadingThread === thread.normalizedKey;

        return (
          <div key={thread.normalizedKey} className={styles.emailThread}>
            {/* Thread header — clickable to expand */}
            <button
              className={`${styles.emailThreadHeader} ${isExpanded ? styles.emailThreadHeaderExpanded : ''}`}
              onClick={() => toggleThread(thread)}
            >
              <div className={styles.emailThreadLeft}>
                <div className={styles.emailThreadSubject}>
                  {lastDirection === 'inbound' && (
                    <span className={styles.emailDirectionBadgeInbound}>In</span>
                  )}
                  {thread.subject}
                  {hasAttachments && (
                    <span className={styles.emailAttachmentIcon} title="Has attachments">📎</span>
                  )}
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
                {isLoadingThis && (
                  <div className={styles.loadingRow}>
                    <span className={styles.spinner} />
                    Loading full email content...
                  </div>
                )}
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
                        {email.hasAttachments && (
                          <span className={styles.emailAttachmentIcon} title="Has attachments">📎</span>
                        )}
                      </div>
                      <span className={styles.emailMessageTime}>
                        {formatFullTimestamp(email.timestamp)}
                      </span>
                    </div>
                    <div className={styles.emailMessageBody}>
                      {resolveBody(email)}
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
