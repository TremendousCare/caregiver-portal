import { useState } from 'react';
import { supabase } from '../../../lib/supabase';
import styles from './messaging.module.css';

const MAX_CHARS = 1000;

/**
 * Inline SMS compose bar at the bottom of the conversation view.
 * Sends via the existing bulk-sms Edge Function with a single caregiver ID.
 */
export function SMSComposeBar({ caregiver, currentUser, onAddNote, showToast }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const hasPhone = !!caregiver.phone;
  const charCount = message.length;
  const canSend = message.trim().length > 0 && charCount <= MAX_CHARS && !sending && hasPhone;

  const handleSend = async () => {
    if (!canSend) return;

    const text = message.trim();
    setSending(true);

    try {
      const { error } = await supabase.functions.invoke('bulk-sms', {
        body: {
          caregiver_ids: [caregiver.id],
          message: text,
          current_user: currentUser?.email || currentUser?.displayName || 'system',
        },
      });

      if (error) throw error;

      // Optimistically add the note to the local state so it appears immediately
      onAddNote(caregiver.id, {
        text,
        type: 'text',
        direction: 'outbound',
        source: 'portal',
      });

      setMessage('');
      if (showToast) showToast('Message sent', 'success');
    } catch (err) {
      console.error('[SMSComposeBar] Send failed:', err);
      if (showToast) showToast('Failed to send message. Please try again.', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!hasPhone) {
    return (
      <div className={styles.composeDisabledMsg}>
        No phone number on file — add one in the profile to send texts
      </div>
    );
  }

  return (
    <div className={styles.composeBar}>
      <div className={styles.composeInputWrapper}>
        <textarea
          className={styles.composeInput}
          placeholder="Type a message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
          rows={1}
        />
        {charCount > 0 && (
          <span className={`${styles.charCount} ${charCount > MAX_CHARS ? styles.charCountOver : charCount > MAX_CHARS * 0.9 ? styles.charCountWarn : ''}`}>
            {charCount}/{MAX_CHARS}
          </span>
        )}
      </div>
      <button
        className={styles.composeButton}
        onClick={handleSend}
        disabled={!canSend}
      >
        {sending ? 'Sending...' : 'Send'}
      </button>
    </div>
  );
}
