import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { buildPriorityItems } from '../../lib/aiPriorities';
import s from './AIPrioritiesPanel.module.css';

export function AIPrioritiesPanel({ caregivers, onSelect }) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('tc_ai_priorities_collapsed') === 'true'
  );
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const subscriptionRef = useRef(null);

  // ── Fetch pending suggestions ──
  const fetchSuggestions = useCallback(async () => {
    const { data } = await supabase
      .from('ai_suggestions')
      .select('id, entity_id, entity_name, action_type, title, detail, drafted_content, status, source_type, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(10);

    if (data) setAiSuggestions(data);
  }, []);

  // ── Initial fetch + Realtime subscription ──
  useEffect(() => {
    fetchSuggestions();

    const channel = supabase
      .channel('ai-priorities-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ai_suggestions' },
        () => fetchSuggestions()
      )
      .subscribe();

    subscriptionRef.current = channel;

    return () => {
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
      }
    };
  }, [fetchSuggestions]);

  // ── Build priority items ──
  const items = useMemo(
    () => buildPriorityItems(aiSuggestions, caregivers),
    [aiSuggestions, caregivers]
  );

  // ── Toggle collapse ──
  const handleToggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('tc_ai_priorities_collapsed', String(next));
  };

  // Don't render if nothing to show
  if (items.length === 0) return null;

  return (
    <div className={s.panel}>
      <div className={s.panelHeader} onClick={handleToggle}>
        <div className={s.panelTitleRow}>
          <span className={s.panelIcon}>{'\u2728'}</span>
          <h3 className={s.panelTitle}>AI Priorities</h3>
          <span className={s.panelCount}>{items.length}</span>
        </div>
        <span className={`${s.chevron} ${collapsed ? s.chevronCollapsed : ''}`}>
          {'\u25BC'}
        </span>
      </div>

      {!collapsed && (
        <div className={s.list}>
          {items.map((item) => {
            const urgencyClass = item.urgency === 'critical' ? s.itemCritical
              : item.urgency === 'warning' ? s.itemWarning
              : s.itemInfo;

            return (
              <div
                key={item.id}
                className={`${s.item} ${urgencyClass}`}
                onClick={() => item.entityId && onSelect(item.entityId)}
              >
                <span className={s.itemIcon}>{item.icon}</span>
                <div className={s.itemContent}>
                  <div className={s.itemTitle}>{item.title}</div>
                  <div className={s.itemReason}>{item.reason}</div>
                  {item.entityName && (
                    <div className={s.itemEntity}>{item.entityName}</div>
                  )}
                </div>
                <button
                  className={s.ctaBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (item.entityId) onSelect(item.entityId);
                  }}
                >
                  {item.ctaLabel}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
