import { useState, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { useApp } from '../../../shared/context/AppContext';
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
  const { currentUserMailbox } = useApp();
  const [expandedThread, setExpandedThread] = useState(null);
  const [loadedBodies, setLoadedBodies] = useState({}); // { outlookId: fullBody } — flat map keyed by email ID
  const [loadingThread, setLoadingThread] = useState(null);

  const threads = groupEmailsByThread(emails);

  // Fetch full email bodies from Outlook when expanding a thread
  const fetchThreadBodies = useCallback(async (thread) => {
    if (!supabase) return;

    const outlookMsgs = thread.messages.filter((m) => m.source === 'outlook');
    if (outlookMsgs.length === 0) return;

    // Check if all Outlook messages in this thread already have loaded bodies
    const allLoaded = outlookMsgs.every((m) => m.outlookId && loadedBodies[m.outlookId]);
    if (allLoaded) return;

    setLoadingThread(thread.normalizedKey);
    try {
      // Try fetching by conversation_id first (gets the full thread in one call)
      const convMsg = outlookMsgs.find((m) => m.conversationId);
      if (convMsg) {
        const { data, error } = await supabase.functions.invoke('outlook-integration', {
          body: { action: 'get_email_thread', admin_email: currentUserMailbox || null, conversation_id: convMsg.conversationId },
        });

        if (!error && data?.emails?.length) {
          // Sort fetched emails chronologically to match our display order
          const fetched = data.emails
            .map((e) => ({
              body: e.body || '',
              timestamp: new Date(e.date).getTime(),
              from: e.from,
              subject: e.subject,
            }))
            .sort((a, b) => a.timestamp - b.timestamp);

          // Match fetched bodies to our messages using multiple strategies
          const newBodies = { ...loadedBodies };
          for (const msg of outlookMsgs) {
            if (msg.outlookId && newBodies[msg.outlookId]) continue;

            const msgTime = new Date(msg.timestamp).getTime();

            // Strategy 1: Match by closest timestamp
            let bestMatch = null;
            let bestDiff = Infinity;
            for (const f of fetched) {
              const diff = Math.abs(f.timestamp - msgTime);
              if (diff < bestDiff) {
                bestDiff = diff;
                bestMatch = f;
              }
            }

            if (bestMatch && msg.outlookId) {
              const body = bestMatch.body.length > 5000
                ? bestMatch.body.substring(0, 5000) + '\n\n... (truncated)'
                : bestMatch.body;
              newBodies[msg.outlookId] = body;
            }
          }

          // Strategy 2: For any still unmatched, assign by position
          const unmatched = outlookMsgs.filter((m) => m.outlookId && !newBodies[m.outlookId]);
          if (unmatched.length > 0 && fetched.length > 0) {
            // Sort unmatched by timestamp and pair with remaining fetched emails
            const sortedUnmatched = [...unmatched].sort(
              (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
            for (let i = 0; i < sortedUnmatched.length && i < fetched.length; i++) {
              const msg = sortedUnmatched[i];
              if (!newBodies[msg.outlookId]) {
                const body = fetched[i].body.length > 5000
                  ? fetched[i].body.substring(0, 5000) + '\n\n... (truncated)'
                  : fetched[i].body;
                newBodies[msg.outlookId] = body;
              }
            }
          }

          setLoadedBodies(newBodies);
          setLoadingThread(null);
          return;
        }
      }

      // Fallback: fetch individual emails by email_id
      const newBodies = { ...loadedBodies };
      for (const msg of outlookMsgs) {
        if (!msg.outlookId || newBodies[msg.outlookId]) continue;
        try {
          const { data, error } = await supabase.functions.invoke('outlook-integration', {
            body: { action: 'get_email_thread', admin_email: currentUserMailbox || null, email_id: msg.outlookId },
          });
          if (!error && data?.emails?.[0]?.body) {
            const body = data.emails[0].body.length > 5000
              ? data.emails[0].body.substring(0, 5000) + '\n\n... (truncated)'
              : data.emails[0].body;
            newBodies[msg.outlookId] = body;
          }
        } catch (err) {
          console.warn('Individual email fetch failed:', msg.outlookId, err);
        }
      }
      setLoadedBodies(newBodies);
    } catch (err) {
      console.warn('Thread fetch error:', err);
    } finally {
      setLoadingThread(null);
    }
  }, [loadedBodies]);

  /**
   * Resolve the display body for an email.
   */
  const resolveBody = (email) => {
    // Portal notes with fullBody stored directly
    if (email.fullBody) return email.fullBody;

    // Check loaded Outlook bodies by email ID
    if (email.outlookId && loadedBodies[email.outlookId]) {
      return loadedBodies[email.outlookId];
    }

    // Fall back to whatever we have
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
      // Lazy-load full bodies for any Outlook-sourced messages that don't have bodies yet
      const needsLoad = thread.messages.some(
        (m) => m.source === 'outlook' && !m.fullBody && m.outlookId && !loadedBodies[m.outlookId]
      );
      if (needsLoad) {
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
          <div key={thread.normalizedKey} className={`${styles.emailThread} ${isExpanded ? styles.emailThreadExpanded : ''}`}>
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
                      {resolveBody(email) || <span className={styles.emailPreviewOnly}>No content available</span>}
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
