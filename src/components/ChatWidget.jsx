import { useState, useRef, useEffect } from 'react';
import { chatStyles as cs } from '../styles/theme';
import { sendMessage } from '../lib/chatApi';
import { buildSystemPrompt } from '../lib/businessContext';

export function ChatWidget({ caregivers, selectedCaregiver }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading]);

  // Focus input when opened
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current.focus(), 100);
    }
  }, [open]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setError(null);
    const userMsg = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const systemPrompt = buildSystemPrompt(caregivers, selectedCaregiver);
      // Send conversation history (last 20 messages to manage token usage)
      const history = newMessages.slice(-20).map(m => ({ role: m.role, content: m.content }));
      const reply = await sendMessage(history, systemPrompt);
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      setError(err.message || 'Failed to get response');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Simple markdown-like formatting for bold and bullet points
  const formatText = (text) => {
    const lines = text.split('\n');
    return lines.map((line, i) => {
      // Bold: **text**
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      const formatted = parts.map((part, j) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={j}>{part.slice(2, -2)}</strong>;
        }
        return part;
      });

      // Bullet points
      if (line.match(/^[-•]\s/)) {
        return <div key={i} style={{ paddingLeft: 12, marginBottom: 2 }}>{formatted}</div>;
      }

      return <div key={i} style={{ marginBottom: line === '' ? 8 : 2 }}>{formatted}</div>;
    });
  };

  return (
    <>
      {/* Floating Action Button */}
      <button
        style={{
          ...cs.fab,
          ...(open ? { transform: 'scale(0.9)' } : {}),
        }}
        onClick={() => setOpen(!open)}
        title={open ? 'Close chat' : 'Chat with TC Assistant'}
      >
        {open ? '✕' : '💬'}
      </button>

      {/* Chat Panel */}
      {open && (
        <div style={cs.panel}>
          {/* Header */}
          <div style={cs.header}>
            <div style={cs.headerIcon}>TC</div>
            <div>
              <div style={cs.headerTitle}>TC Assistant</div>
              <div style={cs.headerSub}>
                {selectedCaregiver
                  ? `Viewing: ${selectedCaregiver.firstName} ${selectedCaregiver.lastName}`
                  : 'Ask me about your pipeline'}
              </div>
            </div>
            <button style={cs.closeBtn} onClick={() => setOpen(false)}>✕</button>
          </div>

          {/* Messages */}
          <div style={cs.messages}>
            {messages.length === 0 && (
              <div style={cs.welcome}>
                Hi! I'm your Tremendous Care assistant. I can help you with:
                <div style={{ marginTop: 8, textAlign: 'left' }}>
                  <div>• Pipeline status and caregiver info</div>
                  <div>• Next steps for any caregiver</div>
                  <div>• Finding caregivers by skills or phase</div>
                  <div>• Recruiting process questions</div>
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                style={msg.role === 'user' ? cs.msgUser : cs.msgAssistant}
              >
                {msg.role === 'user' ? msg.content : formatText(msg.content)}
              </div>
            ))}

            {loading && (
              <div style={cs.typing}>Thinking...</div>
            )}

            {error && (
              <div style={cs.errorMsg}>{error}</div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={cs.inputArea}>
            <input
              ref={inputRef}
              style={cs.input}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={selectedCaregiver
                ? `Ask about ${selectedCaregiver.firstName}...`
                : 'Ask about your pipeline...'}
              disabled={loading}
            />
            <button
              style={{
                ...cs.sendBtn,
                ...(loading || !input.trim() ? cs.sendBtnDisabled : {}),
              }}
              onClick={handleSend}
              disabled={loading || !input.trim()}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
