import { useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useApp } from '../../../shared/context/AppContext';
import { closePendingSuggestionForAction } from '../../../lib/agentLoopClosure';
import styles from './messaging.module.css';

/**
 * Email compose form for the Messaging Center.
 * Hidden behind a "Compose Email" button — expands when clicked.
 * Sends via the existing outlook-integration Edge Function.
 *
 * Works for both caregivers and clients. The Outlook function only
 * needs an email address, so the entity type doesn't affect the send
 * itself — it's just used by the optimistic note write.
 */
export function EmailComposeForm({
  entity,
  entityType = 'caregiver',
  caregiver,
  currentUser,
  onAddNote,
  showToast,
}) {
  const recipient = entity || caregiver;
  const { currentUserMailbox } = useApp();
  const [isOpen, setIsOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const firstName = recipient?.first_name || recipient?.firstName || '';
  const lastName = recipient?.last_name || recipient?.lastName || '';
  const fullName = `${firstName} ${lastName}`.trim();
  const email = recipient?.email;

  const hasEmail = !!email;
  const canSend = subject.trim().length > 0 && body.trim().length > 0 && !sending && hasEmail;

  const handleSend = async () => {
    if (!canSend) return;

    const trimmedSubject = subject.trim();
    const trimmedBody = body.trim();
    setSending(true);

    try {
      const { error } = await supabase.functions.invoke('outlook-integration', {
        body: {
          action: 'send_email',
          admin_email: currentUserMailbox || null,
          to_email: email,
          to_name: fullName || null,
          subject: trimmedSubject,
          body: trimmedBody,
        },
      });

      if (error) throw error;

      // Log as a note so it appears in the thread view immediately
      if (typeof onAddNote === 'function' && recipient?.id) {
        onAddNote(recipient.id, {
          text: `Email sent — Subject: ${trimmedSubject}\n\n${trimmedBody.length > 300 ? trimmedBody.substring(0, 300) + '...' : trimmedBody}`,
          type: 'email',
          direction: 'outbound',
          outcome: `sent via Outlook to ${email}`,
          source: 'portal',
          fullBody: trimmedBody,
          subject: trimmedSubject,
          toEmail: email,
        });
      }

      // Phase 1.5 follow-up — close any matching pending ai_suggestion
      // for this (entity, send_email) and write the agent_actions
      // `phase='executed'` audit row that autonomy v2 reads. Fire-and-
      // forget — the email has already shipped, so a failure here must
      // never affect the UX. See SMSComposeBar.handleSend for the
      // reference pattern.
      if (recipient?.id) {
        closePendingSuggestionForAction({
          entityType,
          entityId: recipient.id,
          actionType: 'send_email',
          params: {
            subject_length: trimmedSubject.length,
            body_length: trimmedBody.length,
          },
        }).catch((closeErr) => {
          console.warn('[EmailComposeForm] suggestion-close failed (non-fatal):', closeErr);
        });
      }

      setSubject('');
      setBody('');
      setIsOpen(false);
      if (showToast) showToast('Email sent', 'success');
    } catch (err) {
      console.error('[EmailComposeForm] Send failed:', err);
      if (showToast) showToast('Failed to send email. Please try again.', 'error');
    } finally {
      setSending(false);
    }
  };

  if (!hasEmail) return null;

  if (!isOpen) {
    return (
      <div className={styles.composeEmailBtnRow}>
        <button
          className={styles.composeEmailBtn}
          onClick={() => setIsOpen(true)}
        >
          + Compose Email
        </button>
      </div>
    );
  }

  return (
    <div className={styles.composeEmailForm}>
      <div className={styles.composeEmailHeader}>
        <span className={styles.composeEmailTitle}>New Email</span>
        <button
          className={styles.composeEmailClose}
          onClick={() => { setIsOpen(false); setSubject(''); setBody(''); }}
          title="Cancel"
        >
          &times;
        </button>
      </div>

      <div className={styles.composeEmailField}>
        <label className={styles.composeEmailLabel}>To</label>
        <div className={styles.composeEmailRecipient}>
          {firstName} {lastName} &lt;{email}&gt;
        </div>
      </div>

      <div className={styles.composeEmailField}>
        <label className={styles.composeEmailLabel}>Subject</label>
        <input
          className={styles.composeEmailInput}
          placeholder="Email subject..."
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={sending}
        />
      </div>

      <div className={styles.composeEmailField}>
        <label className={styles.composeEmailLabel}>Body</label>
        <textarea
          className={styles.composeEmailTextarea}
          placeholder="Write your email..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={sending}
          rows={6}
        />
      </div>

      <div className={styles.composeEmailActions}>
        <button
          className={styles.composeEmailCancel}
          onClick={() => { setIsOpen(false); setSubject(''); setBody(''); }}
          disabled={sending}
        >
          Cancel
        </button>
        <button
          className={styles.composeButton}
          onClick={handleSend}
          disabled={!canSend}
        >
          {sending ? 'Sending...' : 'Send Email'}
        </button>
      </div>
    </div>
  );
}
