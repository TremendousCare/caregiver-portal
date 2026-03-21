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

// ─── Action-specific display config ───
const ACTION_CONFIG = {
  send_sms: { icon: '\u{1F4F1}', label: 'Send SMS', approveLabel: 'Send Reply', color: '#3B82F6' },
  send_email: { icon: '\u{1F4E7}', label: 'Send Email', approveLabel: 'Send Email', color: '#6366F1' },
  add_note: { icon: '\u{1F4DD}', label: 'Add Note', approveLabel: 'Add Note', color: '#8B5CF6' },
  add_client_note: { icon: '\u{1F4DD}', label: 'Add Client Note', approveLabel: 'Add Note', color: '#8B5CF6' },
  update_phase: { icon: '\u{1F4C8}', label: 'Move Phase', approveLabel: 'Move Phase', color: '#F59E0B' },
  update_client_phase: { icon: '\u{1F4C8}', label: 'Move Client Phase', approveLabel: 'Move Phase', color: '#F59E0B' },
  complete_task: { icon: '\u2705', label: 'Complete Task', approveLabel: 'Complete Task', color: '#10B981' },
  complete_client_task: { icon: '\u2705', label: 'Complete Client Task', approveLabel: 'Complete Task', color: '#10B981' },
  update_caregiver_field: { icon: '\u270F\uFE0F', label: 'Update Field', approveLabel: 'Update', color: '#6B7280' },
  update_client_field: { icon: '\u270F\uFE0F', label: 'Update Client Field', approveLabel: 'Update', color: '#6B7280' },
  update_board_status: { icon: '\u{1F4CB}', label: 'Move on Board', approveLabel: 'Move', color: '#0EA5E9' },
  create_calendar_event: { icon: '\u{1F4C5}', label: 'Schedule Event', approveLabel: 'Schedule', color: '#EC4899' },
  send_docusign_envelope: { icon: '\u{1F58A}\uFE0F', label: 'Send DocuSign', approveLabel: 'Send DocuSign', color: '#EAB308' },
};

function getActionPreview(suggestion) {
  const params = suggestion.action_params || {};
  const action = suggestion.action_type;
  if (!action) return null;

  switch (action) {
    case 'complete_task':
    case 'complete_client_task':
      return params.task_id ? `Task: ${params.task_id}` : null;
    case 'update_phase':
    case 'update_client_phase':
      return params.new_phase ? `Move to: ${params.new_phase}${params.reason ? ` — ${params.reason}` : ''}` : null;
    case 'update_board_status':
      return params.new_status ? `Move to: ${params.new_status}` : null;
    case 'update_caregiver_field':
    case 'update_client_field':
      return params.field ? `${params.field} \u2192 "${params.value}"` : null;
    case 'create_calendar_event':
      return params.title ? `${params.title} on ${params.date || '?'} at ${params.start_time || '?'}` : null;
    case 'send_docusign_envelope':
      return params.caregiver_name ? `Send to: ${params.caregiver_name}` : null;
    case 'send_email':
      return params.subject ? `Subject: ${params.subject}` : null;
    default:
      return null;
  }
}

export function NotificationCenter({ currentUser }) {
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState('pending'); // 'pending' | 'history'
  const [suggestions, setSuggestions] = useState([]);
  const [autoExecuted, setAutoExecuted] = useState([]);
  const [history, setHistory] = useState([]);
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

  // ─── Fetch recent history (executed, rejected, auto-executed) ───
  const fetchHistory = useCallback(async () => {
    const { data, error } = await supabase
      .from('ai_suggestions')
      .select('*')
      .in('status', ['executed', 'auto_executed', 'rejected', 'failed'])
      .order('resolved_at', { ascending: false })
      .limit(20);

    if (!error && data) {
      setHistory(data);
    }
  }, []);

  // ─── Fetch recent auto-executed suggestions (last 1 hour) ───
  const fetchAutoExecuted = useCallback(async () => {
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const { data, error } = await supabase
      .from('ai_suggestions')
      .select('*')
      .eq('status', 'auto_executed')
      .gte('resolved_at', oneHourAgo)
      .order('resolved_at', { ascending: false })
      .limit(10);

    if (!error && data) {
      setAutoExecuted(data);
    }
  }, []);

  // ─── Initial fetch + Realtime subscription ───
  useEffect(() => {
    fetchSuggestions();
    fetchHistory();
    fetchAutoExecuted();

    // Subscribe to ai_suggestions changes via Realtime
    const channel = supabase
      .channel('ai-suggestions-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ai_suggestions' },
        () => {
          // Refetch on any change
          fetchSuggestions();
          fetchHistory();
          fetchAutoExecuted();
        }
      )
      .subscribe();

    subscriptionRef.current = channel;

    return () => {
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
      }
    };
  }, [fetchSuggestions, fetchHistory, fetchAutoExecuted]);

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
      // Route through ai-chat manage_suggestions so recordAutonomyOutcome is called
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      let rejected = false;

      if (token) {
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
                content: `Reject the AI suggestion with ID: ${suggestion.id}`,
              }],
              currentUser: currentUser || 'User',
              toolCall: {
                name: 'manage_suggestions',
                input: { action: 'reject', suggestion_id: suggestion.id },
              },
            }),
          }
        );
        rejected = res.ok;
      }

      // Fallback: direct DB update if ai-chat call fails (rejects should never get stuck)
      if (!rejected) {
        await supabase
          .from('ai_suggestions')
          .update({
            status: 'rejected',
            resolved_at: new Date().toISOString(),
            resolved_by: `user:${currentUser || 'unknown'}`,
          })
          .eq('id', suggestion.id);
      }

      // Optimistic update — remove from local state
      setSuggestions(prev => prev.filter(s => s.id !== suggestion.id));
      setAutoExecuted(prev => prev.filter(s => s.id !== suggestion.id));
    } catch (err) {
      console.error('Failed to reject suggestion:', err);
    } finally {
      setActionInProgress(null);
    }
  }, [currentUser]);

  const pendingCount = suggestions.length + autoExecuted.length;

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

          {/* Tabs */}
          <div className={s.tabs}>
            <button
              className={`${s.tab} ${tab === 'pending' ? s.tabActive : ''}`}
              onClick={() => setTab('pending')}
            >
              Pending{pendingCount > 0 ? ` (${pendingCount})` : ''}
            </button>
            <button
              className={`${s.tab} ${tab === 'history' ? s.tabActive : ''}`}
              onClick={() => setTab('history')}
            >
              History
            </button>
          </div>

          <div className={s.suggestionList}>
            {tab === 'pending' ? (
              suggestions.length === 0 && autoExecuted.length === 0 ? (
                <div className={s.emptyState}>
                  <div className={s.emptyIcon}>{'\u2705'}</div>
                  <div className={s.emptyText}>No pending suggestions</div>
                  <div className={s.emptySub}>
                    The AI will suggest actions when inbound messages arrive
                  </div>
                </div>
              ) : (
                <>
                  {/* Auto-executed suggestions (last 1 hour) */}
                  {autoExecuted.length > 0 && (
                    <div className={s.autoExecutedSection}>
                      <div className={s.autoExecutedHeader}>
                        {'\u{1F916}'} Auto-executed ({autoExecuted.length})
                      </div>
                      {autoExecuted.map((sug) => (
                        <AutoExecutedCard
                          key={sug.id}
                          suggestion={sug}
                          onUndo={handleReject}
                          isLoading={actionInProgress === sug.id}
                        />
                      ))}
                    </div>
                  )}

                  {/* Pending suggestions needing approval */}
                  {suggestions.map((sug) => (
                    <SuggestionCard
                      key={sug.id}
                      suggestion={sug}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      isLoading={actionInProgress === sug.id}
                    />
                  ))}
                </>
              )
            ) : (
              history.length === 0 ? (
                <div className={s.emptyState}>
                  <div className={s.emptyIcon}>{'\u{1F4C2}'}</div>
                  <div className={s.emptyText}>No history yet</div>
                  <div className={s.emptySub}>
                    Resolved suggestions will appear here
                  </div>
                </div>
              ) : (
                history.map((sug) => (
                  <HistoryCard key={sug.id} suggestion={sug} />
                ))
              )
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Suggestion Card Component ───

function SuggestionCard({ suggestion, onApprove, onReject, isLoading }) {
  const actionConfig = ACTION_CONFIG[suggestion.action_type] || null;
  const icon = actionConfig?.icon || TYPE_ICONS[suggestion.suggestion_type] || '\u{1F4CB}';
  const levelLabel = LEVEL_LABELS[suggestion.autonomy_level] || suggestion.autonomy_level;
  const age = formatAge(suggestion.created_at);
  const actionPreview = getActionPreview(suggestion);

  const showActions = suggestion.autonomy_level === 'L2' || suggestion.autonomy_level === 'L1';

  // Smart approve label: use action-specific label when available
  const approveLabel = isLoading
    ? 'Executing...'
    : actionConfig?.approveLabel || (suggestion.suggestion_type === 'reply' ? 'Send Reply' : 'Approve');

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <span className={s.cardIcon}>{icon}</span>
        <span className={s.cardTitle}>{suggestion.title}</span>
        <span className={s.cardAge}>{age}</span>
      </div>

      {/* Action type badge */}
      {actionConfig && (
        <div className={s.actionBadge} style={{ color: actionConfig.color, borderColor: actionConfig.color + '33', background: actionConfig.color + '0A' }}>
          {actionConfig.label}
        </div>
      )}

      {suggestion.detail && (
        <div className={s.cardDetail}>{suggestion.detail}</div>
      )}

      {/* Action-specific preview (task name, phase, calendar event, etc.) */}
      {actionPreview && (
        <div className={s.actionPreview}>{actionPreview}</div>
      )}

      {/* Drafted content (message body, email body, note text) */}
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
            {approveLabel}
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

// ─── Auto-Executed Card Component (shows recent L3/L4 auto-actions with Undo) ───

function AutoExecutedCard({ suggestion, onUndo, isLoading }) {
  const actionConfig = ACTION_CONFIG[suggestion.action_type] || null;
  const icon = actionConfig?.icon || TYPE_ICONS[suggestion.suggestion_type] || '\u{1F4CB}';
  const age = suggestion.resolved_at ? formatAge(suggestion.resolved_at) : formatAge(suggestion.created_at);

  return (
    <div className={`${s.card} ${s.cardAutoExecuted}`}>
      <div className={s.cardHeader}>
        <span className={s.cardIcon}>{icon}</span>
        <span className={s.cardTitle}>{suggestion.title}</span>
        <span className={s.cardAge}>{age}</span>
      </div>

      {actionConfig && (
        <div className={s.actionBadge} style={{ color: actionConfig.color, borderColor: actionConfig.color + '33', background: actionConfig.color + '0A' }}>
          {actionConfig.label}
        </div>
      )}

      {suggestion.detail && (
        <div className={s.cardDetail}>{suggestion.detail}</div>
      )}

      <div className={s.autoExecutedFooter}>
        <span className={s.autoExecutedBadge}>
          {'\u2713'} Auto-executed
        </span>
        <button
          className={s.undoBtn}
          onClick={() => onUndo(suggestion)}
          disabled={isLoading}
          title="Undo this action and record as rejected"
        >
          {isLoading ? 'Undoing...' : 'Undo'}
        </button>
      </div>
    </div>
  );
}

// ─── History Card Component (read-only, shows resolved suggestions) ───

const STATUS_DISPLAY = {
  executed: { icon: '\u2705', label: 'Executed', className: 'statusExecuted' },
  auto_executed: { icon: '\u{1F916}', label: 'Auto-executed', className: 'statusExecuted' },
  rejected: { icon: '\u274C', label: 'Dismissed', className: 'statusRejected' },
  failed: { icon: '\u26A0\uFE0F', label: 'Failed', className: 'statusRejected' },
};

function HistoryCard({ suggestion }) {
  const actionConfig = ACTION_CONFIG[suggestion.action_type] || null;
  const icon = actionConfig?.icon || TYPE_ICONS[suggestion.suggestion_type] || '\u{1F4CB}';
  const statusInfo = STATUS_DISPLAY[suggestion.status] || { icon: '\u2753', label: suggestion.status };
  const age = suggestion.resolved_at ? formatAge(suggestion.resolved_at) : formatAge(suggestion.created_at);

  return (
    <div className={`${s.card} ${s.cardHistory}`}>
      <div className={s.cardHeader}>
        <span className={s.cardIcon}>{icon}</span>
        <span className={s.cardTitle}>{suggestion.title}</span>
        <span className={s.cardAge}>{age}</span>
      </div>

      {actionConfig && (
        <div className={s.actionBadge} style={{ color: actionConfig.color, borderColor: actionConfig.color + '33', background: actionConfig.color + '0A' }}>
          {actionConfig.label}
        </div>
      )}

      {suggestion.detail && (
        <div className={s.cardDetail}>{suggestion.detail}</div>
      )}

      <div className={s[statusInfo.className] || s.statusExecuted}>
        {statusInfo.icon} {statusInfo.label}
        {suggestion.resolved_by ? ` by ${suggestion.resolved_by.replace('user:', '').replace('system:', 'AI ')}` : ''}
      </div>
    </div>
  );
}
