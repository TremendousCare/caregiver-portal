import { useState, useRef, useEffect, useCallback } from 'react';
import DOMPurify from 'dompurify';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import s from './AIChatbot.module.css';

// ─── Simple markdown-like formatting (sanitized) ───
function formatMessage(text) {
  if (!text) return '';
  const html = text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code style="background:#F0F2F5;padding:2px 6px;border-radius:4px;font-size:13px">$1</code>')
    .replace(/^### (.*$)/gm, '<h4 style="margin:12px 0 4px;font-size:14px;color:#1B2A4A">$1</h4>')
    .replace(/^## (.*$)/gm, '<h3 style="margin:14px 0 6px;font-size:15px;color:#1B2A4A">$1</h3>')
    .replace(/^- (.*$)/gm, '<div style="padding-left:12px;margin:3px 0">&bull; $1</div>')
    .replace(/^\d+\. (.*$)/gm, '<div style="padding-left:12px;margin:3px 0">$&</div>')
    .replace(/\n/g, '<br/>');
  return DOMPurify.sanitize(html, { ADD_ATTR: ['style'] });
}

const QUICK_ACTIONS = [
  { label: 'Pipeline summary', prompt: 'Give me a quick summary of the current pipeline' },
  { label: 'Who needs follow-up?', prompt: 'Who needs a follow-up? Find stale leads that may be falling through the cracks' },
  { label: 'Compliance check', prompt: 'Run a compliance check across all caregivers' },
  { label: 'Draft follow-up', prompt: 'Draft a follow-up text message for our most stale lead' },
];

export function AIChatbot({ caregiverId, currentUser }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const callEdgeFunction = useCallback(async (body) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');

    const { data, error } = await supabase.functions.invoke('ai-chat', {
      body,
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    if (error) throw error;
    return data;
  }, []);

  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || loading) return;

    const userMessage = { role: 'user', content: text.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setLoading(true);
    setPendingConfirmation(null);

    try {
      if (!isSupabaseConfigured()) throw new Error('Supabase not configured');

      const data = await callEdgeFunction({
        messages: newMessages.map(m => ({ role: m.role, content: m.content })),
        caregiverId: caregiverId || null,
        currentUser: currentUser || 'User',
      });

      const aiMessage = { role: 'assistant', content: data.reply || 'No response received.' };
      setMessages([...newMessages, aiMessage]);

      if (data.pendingConfirmation) {
        setPendingConfirmation(data.pendingConfirmation);
      }
    } catch (err) {
      console.error('AI chat error:', err);
      setMessages([...newMessages, {
        role: 'assistant',
        content: `Sorry, I couldn't process that request. ${err.message || 'Please try again.'}`,
      }]);
    } finally {
      setLoading(false);
    }
  }, [messages, loading, caregiverId, currentUser, callEdgeFunction]);

  const handleConfirm = useCallback(async (approved) => {
    if (!pendingConfirmation) return;

    const confirmation = pendingConfirmation;
    setPendingConfirmation(null);

    if (!approved) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Action cancelled.',
      }]);
      return;
    }

    setLoading(true);
    try {
      const data = await callEdgeFunction({
        confirmAction: {
          action: confirmation.action,
          caregiver_id: confirmation.caregiver_id,
          params: confirmation.params,
        },
        currentUser: currentUser || 'User',
      });

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.reply || 'Action completed.',
      }]);
    } catch (err) {
      console.error('Confirm error:', err);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error executing action: ${err.message || 'Please try again.'}`,
      }]);
    } finally {
      setLoading(false);
    }
  }, [pendingConfirmation, currentUser, callEdgeFunction]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  if (!isSupabaseConfigured()) return null;

  return (
    <>
      {/* Floating action button */}
      <button
        className={`${s.fab}${isOpen ? ` ${s.fabOpen}` : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="AI Assistant"
      >
        {isOpen ? '\u2715' : <span className={s.fabLabel}>AI</span>}
        {!isOpen && messages.length === 0 && <div className={s.fabBadge} />}
      </button>

      {/* Chat panel */}
      {isOpen && (
        <div className={s.panel}>
          {/* Header */}
          <div className={s.header}>
            <div>
              <div className={s.headerTitle}>TC Assistant</div>
              <div className={s.headerSub}>Powered by Claude AI</div>
            </div>
            <button className={s.closeBtn} onClick={() => setIsOpen(false)}>
              {'\u2715'}
            </button>
          </div>

          {/* Quick actions (show when no messages) */}
          {messages.length === 0 && (
            <div className={s.quickActions}>
              {QUICK_ACTIONS.map((qa) => (
                <button
                  key={qa.label}
                  className={s.quickBtn}
                  onClick={() => sendMessage(qa.prompt)}
                >
                  {qa.label}
                </button>
              ))}
            </div>
          )}

          {/* Messages */}
          <div className={s.messages}>
            {messages.length === 0 && (
              <div className={s.welcome}>
                <div className={s.welcomeIcon}>AI</div>
                <div className={s.welcomeTitle}>Hi{currentUser ? `, ${currentUser}` : ''}!</div>
                <div className={s.welcomeText}>
                  I'm your AI recruiting assistant. I can search caregivers, check compliance,
                  add notes, draft messages, and update records. Ask me anything!
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={msg.role === 'user' ? s.userMsg : s.aiMsg}
                dangerouslySetInnerHTML={
                  msg.role === 'assistant'
                    ? { __html: formatMessage(msg.content) }
                    : undefined
                }
              >
                {msg.role === 'user' ? msg.content : undefined}
              </div>
            ))}

            {/* Pending confirmation card */}
            {pendingConfirmation && !loading && (
              <div className={s.confirmCard}>
                <div className={s.confirmLabel}>Confirm Action</div>
                <div dangerouslySetInnerHTML={{ __html: formatMessage(pendingConfirmation.summary) }} />
                <div className={s.confirmActions}>
                  <button
                    className={s.confirmBtnApprove}
                    onClick={() => handleConfirm(true)}
                  >
                    Confirm
                  </button>
                  <button
                    className={s.confirmBtnCancel}
                    onClick={() => handleConfirm(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {loading && (
              <div className={s.typing}>
                <span className={s.typingDot1}>{'\u25CF'}</span>
                <span className={s.typingDot2}>{'\u25CF'}</span>
                <span className={s.typingDot3}>{'\u25CF'}</span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className={s.inputArea}>
            <textarea
              ref={inputRef}
              className={s.input}
              placeholder="Ask about your pipeline..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <button
              className={s.sendBtn}
              style={{ opacity: !input.trim() || loading ? 0.5 : 1 }}
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || loading}
            >
              {'\u27A4'}
            </button>
          </div>
        </div>
      )}

    </>
  );
}
