import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import s from './NotificationCenter.module.css';

// ─── Age formatting ───
function formatAge(createdAt) {
  const mins = Math.round((Date.now() - new Date(createdAt).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// ─── Type icons ───
const TYPE_ICONS = {
  reply: '\u{1F4AC}',    // 💬
  action: '\u26A1',      // ⚡
  alert: '\u{1F6A8}',    // 🚨
  follow_up: '\u{1F4CB}', // 📋
};

const LEVEL_LABELS = {
  L1: 'Suggest',
  L2: 'Confirm',
  L3: 'Notify',
  L4: 'Auto',
};

export function NotificationCenter({ currentUser }) {
  const [isOpen, setIsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [actionInProgress, setActionInProgress] = useState(null);
  const subscriptionRef = useRef(null);

  // ─── Fetch pending suggestions ───
  const fetchSuggestions = useCallback(async () => {
    const { data, error } = await supabase
      .from('ai_suggestions')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(20);

    if (!error && data) {
      setSuggestions(data);
    }
  }, []);

  // ─── Initial fetch + Realtime subscription ───
  useEffect(() => {
    fetchSuggestions();

    // Subscribe to ai_suggestions changes via Realtime
    const channel = supabase
      .channel('ai-suggestions-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ai_suggestions' },
        () => {
          // Refetch on any change
          fetchSuggestions();
        }
      )
      .subscribe();

    subscriptionRef.current = channel;

    return () => {
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
      }
    };
  }, [fetchSuggestions]);

  // ─── Approve suggestion ───
  const handleApprove = useCallback(async (suggestion) => {
    setActionInProgress(suggestion.id);
    try {
      // Call the ai-chat Edge Function to execute the suggestion
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (!token) {
        console.error('No auth token for suggestion execution');
        return;
      }

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL || 'https://zocrnurvazyxdpyqimgj.supabase.co'}/functions/v1/ai-chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            messages: [{
              role: 'user',
              content: `Approve and execute the AI suggestion with ID: ${suggestion.id}`,
            }],
            currentUser: currentUser || 'User',
            toolCall: {
              name: 'manage_suggestions',
              input: { action: 'approve', suggestion_id: suggestion.id },
            },
          }),
        }
      );

      if (res.ok) {
        // Optimistic update — remove from local state
        setSuggestions(prev => prev.filter(s => s.id !== suggestion.id));
      }
    } catch (err) {
      console.error('Failed to approve suggestion:', err);
    } finally {
      setActionInProgress(null);
    }
  }, [currentUser]);

  // ─── Reject suggestion ───
  const handleReject = useCallback(async (suggestion) => {
    setActionInProgress(suggestion.id);
    try {
      // Direct DB update for rejection (simpler than going through ai-chat)
      const { error } = await supabase
        .from('ai_suggestions')
        .update({
          status: 'rejected',
          resolved_at: new Date().toISOString(),
          resolved_by: `user:${currentUser || 'unknown'}`,
        })
        .eq('id', suggestion.id);

      if (!error) {
        setSuggestions(prev => prev.filter(s => s.id !== suggestion.id));
      }
    } catch (err) {
      console.error('Failed to reject suggestion:', err);
    } finally {
      setActionInProgress(null);
    }
  }, [currentUser]);

  const pendingCount = suggestions.length;

  return (
    <>
      {/* Bell Button */}
      <button
        className={`${s.bellButton} ${isOpen ? s.bellButtonActive : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title={pendingCount > 0 ? `${pendingCount} pending suggestion(s)` : 'No pending suggestions'}
      >
        {isOpen ? '\u2715' : '\u{1F514}'}
        {pendingCount > 0 && !isOpen && (
          <span className={s.badge}>{pendingCount > 9 ? '9+' : pendingCount}</span>
        )}
      </button>

      {/* Backdrop */}
      {isOpen && (
        <div className={s.backdrop} onClick={() => setIsOpen(false)} />
      )}

      {/* Dropdown Panel */}
      {isOpen && (
        <div className={s.panel}>
          <div className={s.panelHeader}>
            <span className={s.panelTitle}>AI Suggestions</span>
            <span className={s.panelCount}>
              {pendingCount === 0 ? 'All clear' : `${pendingCount} pending`}
            </span>
          </div>

          <div className={s.suggestionList}>
            {suggestions.length === 0 ? (
              <div className={s.emptyState}>
                <div className={s.emptyIcon}>{'\u2705'}</div>
                <div className={s.emptyText}>No pending suggestions</div>
                <div className={s.emptySub}>
                  The AI will suggest actions when inbound messages arrive
                </div>
              </div>
            ) : (
              suggestions.map((sug) => (
                <SuggestionCard
                  key={sug.id}
                  suggestion={sug}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  isLoading={actionInProgress === sug.id}
                />
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Suggestion Card Component ───

function SuggestionCard({ suggestion, onApprove, onReject, isLoading }) {
  const icon = TYPE_ICONS[suggestion.suggestion_type] || '\u{1F4CB}';
  const levelLabel = LEVEL_LABELS[suggestion.autonomy_level] || suggestion.autonomy_level;
  const age = formatAge(suggestion.created_at);

  const showActions = suggestion.autonomy_level === 'L2' || suggestion.autonomy_level === 'L1';

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <span className={s.cardIcon}>{icon}</span>
        <span className={s.cardTitle}>{suggestion.title}</span>
        <span className={s.cardAge}>{age}</span>
      </div>

      {suggestion.detail && (
        <div className={s.cardDetail}>{suggestion.detail}</div>
      )}

      {suggestion.drafted_content && (
        <div className={s.cardDraft}>
          &ldquo;{suggestion.drafted_content.length > 150
            ? suggestion.drafted_content.substring(0, 150) + '...'
            : suggestion.drafted_content}&rdquo;
        </div>
      )}

      <span className={s.cardLevel}>{levelLabel}</span>

      {showActions && (
        <div className={s.cardActions}>
          <button
            className={s.approveBtn}
            onClick={() => onApprove(suggestion)}
            disabled={isLoading}
          >
            {isLoading ? 'Executing...' : suggestion.suggestion_type === 'reply' ? 'Send Reply' : 'Approve'}
          </button>
          <button
            className={s.rejectBtn}
            onClick={() => onReject(suggestion)}
            disabled={isLoading}
          >
            Dismiss
          </button>
        </div>
      )}

      {suggestion.autonomy_level === 'L3' && (
        <div className={s.statusExecuted}>
          {'\u2713'} Auto-executed
        </div>
      )}
    </div>
  );
}
