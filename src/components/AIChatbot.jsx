import { useState, useRef, useEffect, useCallback } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

// ─── Simple markdown-like formatting ───
function formatMessage(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code style="background:#F0F2F5;padding:2px 6px;border-radius:4px;font-size:13px">$1</code>')
    .replace(/^### (.*$)/gm, '<h4 style="margin:12px 0 4px;font-size:14px;color:#1B2A4A">$1</h4>')
    .replace(/^## (.*$)/gm, '<h3 style="margin:14px 0 6px;font-size:15px;color:#1B2A4A">$1</h3>')
    .replace(/^- (.*$)/gm, '<div style="padding-left:12px;margin:3px 0">&bull; $1</div>')
    .replace(/^\d+\. (.*$)/gm, '<div style="padding-left:12px;margin:3px 0">$&</div>')
    .replace(/\n/g, '<br/>');
}

const CHAT_STYLES = {
  // Floating button
  fab: {
    position: 'fixed',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #1B2A4A, #2E4E8D)',
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
    boxShadow: '0 6px 24px rgba(26,26,26,0.3)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 24,
    zIndex: 1000,
    transition: 'transform 0.2s, box-shadow 0.2s',
  },
  fabBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: '#29BEE4',
    border: '2px solid #fff',
  },
  // Chat panel
  panel: {
    position: 'fixed',
    bottom: 90,
    right: 24,
    width: 400,
    maxWidth: 'calc(100vw - 48px)',
    height: 520,
    maxHeight: 'calc(100vh - 120px)',
    background: '#fff',
    borderRadius: 16,
    boxShadow: '0 16px 48px rgba(26,26,26,0.2), 0 0 0 1px rgba(0,0,0,0.05)',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 1001,
    overflow: 'hidden',
  },
  // Header
  header: {
    padding: '16px 20px',
    background: 'linear-gradient(135deg, #1B2A4A, #2E4E8D)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: 0.3,
  },
  headerSub: {
    fontSize: 11,
    opacity: 0.7,
    fontWeight: 400,
  },
  closeBtn: {
    background: 'rgba(255,255,255,0.15)',
    border: 'none',
    color: '#fff',
    width: 28,
    height: 28,
    borderRadius: 8,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
  },
  // Messages
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  userMsg: {
    alignSelf: 'flex-end',
    background: 'linear-gradient(135deg, #2E4E8D, #1B2A4A)',
    color: '#fff',
    padding: '10px 14px',
    borderRadius: '14px 14px 4px 14px',
    maxWidth: '85%',
    fontSize: 13,
    lineHeight: 1.5,
    wordBreak: 'break-word',
  },
  aiMsg: {
    alignSelf: 'flex-start',
    background: '#F0F2F5',
    color: '#1A1A1A',
    padding: '10px 14px',
    borderRadius: '14px 14px 14px 4px',
    maxWidth: '85%',
    fontSize: 13,
    lineHeight: 1.6,
    wordBreak: 'break-word',
  },
  typing: {
    alignSelf: 'flex-start',
    background: '#F0F2F5',
    padding: '10px 16px',
    borderRadius: '14px 14px 14px 4px',
    fontSize: 13,
    color: '#8BA3C7',
    display: 'flex',
    gap: 4,
  },
  // Input
  inputArea: {
    padding: '12px 16px',
    borderTop: '1px solid #E8ECF0',
    display: 'flex',
    gap: 8,
    background: '#FAFBFC',
  },
  input: {
    flex: 1,
    border: '1px solid #E0E4EA',
    borderRadius: 10,
    padding: '10px 14px',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
    resize: 'none',
    minHeight: 20,
    maxHeight: 80,
    lineHeight: 1.4,
  },
  sendBtn: {
    background: 'linear-gradient(135deg, #1B2A4A, #2E4E8D)',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    padding: '0 14px',
    cursor: 'pointer',
    fontSize: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 40,
  },
  // Quick actions
  quickActions: {
    padding: '8px 16px',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    borderBottom: '1px solid #E8ECF0',
  },
  quickBtn: {
    background: '#F0F2F5',
    border: '1px solid #E0E4EA',
    borderRadius: 8,
    padding: '5px 10px',
    fontSize: 11,
    cursor: 'pointer',
    color: '#2E4E8D',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    transition: 'background 0.15s',
  },
  // Welcome
  welcome: {
    textAlign: 'center',
    padding: '24px 16px',
    color: '#6B7C93',
  },
  welcomeTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: '#1B2A4A',
    marginBottom: 6,
  },
  welcomeText: {
    fontSize: 12,
    lineHeight: 1.6,
    color: '#8BA3C7',
  },
  // Confirmation card
  confirmCard: {
    alignSelf: 'flex-start',
    background: '#FFFBEB',
    border: '1px solid #F59E0B',
    borderRadius: 12,
    padding: '12px 14px',
    maxWidth: '90%',
    fontSize: 13,
    lineHeight: 1.5,
  },
  confirmLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: '#B45309',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  confirmActions: {
    display: 'flex',
    gap: 8,
    marginTop: 10,
  },
  confirmBtn: {
    padding: '6px 16px',
    borderRadius: 8,
    border: 'none',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
};

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
        style={{
          ...CHAT_STYLES.fab,
          ...(isOpen ? { transform: 'scale(0.9)' } : {}),
        }}
        onClick={() => setIsOpen(!isOpen)}
        title="AI Assistant"
      >
        {isOpen ? '\u2715' : <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: -0.5 }}>AI</span>}
        {!isOpen && messages.length === 0 && <div style={CHAT_STYLES.fabBadge} />}
      </button>

      {/* Chat panel */}
      {isOpen && (
        <div style={CHAT_STYLES.panel}>
          {/* Header */}
          <div style={CHAT_STYLES.header}>
            <div>
              <div style={CHAT_STYLES.headerTitle}>TC Assistant</div>
              <div style={CHAT_STYLES.headerSub}>Powered by Claude AI</div>
            </div>
            <button style={CHAT_STYLES.closeBtn} onClick={() => setIsOpen(false)}>
              {'\u2715'}
            </button>
          </div>

          {/* Quick actions (show when no messages) */}
          {messages.length === 0 && (
            <div style={CHAT_STYLES.quickActions}>
              {QUICK_ACTIONS.map((qa) => (
                <button
                  key={qa.label}
                  style={CHAT_STYLES.quickBtn}
                  onClick={() => sendMessage(qa.prompt)}
                  onMouseEnter={(e) => { e.target.style.background = '#E0E4EA'; }}
                  onMouseLeave={(e) => { e.target.style.background = '#F0F2F5'; }}
                >
                  {qa.label}
                </button>
              ))}
            </div>
          )}

          {/* Messages */}
          <div style={CHAT_STYLES.messages}>
            {messages.length === 0 && (
              <div style={CHAT_STYLES.welcome}>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#2E4E8D', background: 'linear-gradient(135deg, #1B2A4A, #2E4E8D)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: -1, marginBottom: 12 }}>AI</div>
                <div style={CHAT_STYLES.welcomeTitle}>Hi{currentUser ? `, ${currentUser}` : ''}!</div>
                <div style={CHAT_STYLES.welcomeText}>
                  I'm your AI recruiting assistant. I can search caregivers, check compliance,
                  add notes, draft messages, and update records. Ask me anything!
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                style={msg.role === 'user' ? CHAT_STYLES.userMsg : CHAT_STYLES.aiMsg}
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
              <div style={CHAT_STYLES.confirmCard}>
                <div style={CHAT_STYLES.confirmLabel}>Confirm Action</div>
                <div dangerouslySetInnerHTML={{ __html: formatMessage(pendingConfirmation.summary) }} />
                <div style={CHAT_STYLES.confirmActions}>
                  <button
                    style={{ ...CHAT_STYLES.confirmBtn, background: '#059669', color: '#fff' }}
                    onClick={() => handleConfirm(true)}
                    onMouseEnter={(e) => { e.target.style.background = '#047857'; }}
                    onMouseLeave={(e) => { e.target.style.background = '#059669'; }}
                  >
                    Confirm
                  </button>
                  <button
                    style={{ ...CHAT_STYLES.confirmBtn, background: '#E5E7EB', color: '#374151' }}
                    onClick={() => handleConfirm(false)}
                    onMouseEnter={(e) => { e.target.style.background = '#D1D5DB'; }}
                    onMouseLeave={(e) => { e.target.style.background = '#E5E7EB'; }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {loading && (
              <div style={CHAT_STYLES.typing}>
                <span style={{ animation: 'pulse 1.5s infinite' }}>{'\u25CF'}</span>
                <span style={{ animation: 'pulse 1.5s infinite 0.3s' }}>{'\u25CF'}</span>
                <span style={{ animation: 'pulse 1.5s infinite 0.6s' }}>{'\u25CF'}</span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={CHAT_STYLES.inputArea}>
            <textarea
              ref={inputRef}
              style={CHAT_STYLES.input}
              placeholder="Ask about your pipeline..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <button
              style={{
                ...CHAT_STYLES.sendBtn,
                opacity: !input.trim() || loading ? 0.5 : 1,
              }}
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || loading}
            >
              {'\u27A4'}
            </button>
          </div>
        </div>
      )}

      {/* Typing animation CSS */}
      <style>{`
        @keyframes pulse {
          0%, 60%, 100% { opacity: 0.3; }
          30% { opacity: 1; }
        }
      `}</style>
    </>
  );
}
