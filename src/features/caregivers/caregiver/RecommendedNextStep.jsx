import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../../lib/supabase';
import { getRecommendation } from '../../../lib/aiPriorities';
import s from './RecommendedNextStep.module.css';

export function RecommendedNextStep({ caregiver }) {
  const [suggestion, setSuggestion] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const subscriptionRef = useRef(null);

  // ── Fetch latest suggestion for this caregiver ──
  const fetchSuggestion = useCallback(async () => {
    if (!caregiver?.id) return;

    const { data } = await supabase
      .from('ai_suggestions')
      .select('*')
      .eq('entity_id', caregiver.id)
      .in('status', ['pending', 'auto_executed'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    setSuggestion(data || null);
  }, [caregiver?.id]);

  // ── Initial fetch + Realtime ──
  useEffect(() => {
    fetchSuggestion();

    const channel = supabase
      .channel(`ai-next-step-${caregiver?.id || 'none'}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ai_suggestions' },
        (payload) => {
          // Only refetch if the change involves this entity
          if (payload.new?.entity_id === caregiver?.id || payload.old?.entity_id === caregiver?.id) {
            fetchSuggestion();
          }
        }
      )
      .subscribe();

    subscriptionRef.current = channel;

    return () => {
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
      }
    };
  }, [caregiver?.id, fetchSuggestion]);

  const rec = getRecommendation(suggestion, caregiver);

  // Use subtle styling for "on track" — don't be noisy
  const isOnTrack = rec.title === 'On track';
  const isAi = rec.source === 'ai';

  const cardClass = isOnTrack ? s.cardOnTrack
    : isAi ? `${s.card} ${s.cardAi}`
    : s.card;

  return (
    <div className={cardClass}>
      <div className={s.header}>
        <span className={s.headerIcon}>{isAi ? '\u{1F4A1}' : '\u{1F4CB}'}</span>
        <span className={s.headerTitle}>
          {isAi ? 'AI Recommendation' : 'Recommended Next Step'}
        </span>
        <span className={`${s.badge} ${isAi ? s.badgeAi : s.badgeHeuristic}`}>
          {isAi ? 'AI' : 'Insight'}
        </span>
      </div>

      <div className={s.title}>{rec.title}</div>
      {rec.reason && <div className={s.reason}>{rec.reason}</div>}
      {rec.risk && <div className={s.risk}>{rec.risk}</div>}

      <div className={s.actionsRow}>
        <button
          className={`${s.ctaBtn} ${rec.ctaType === 'primary' ? s.ctaPrimary : s.ctaSecondary}`}
          onClick={() => {
            // Scroll to relevant section on the same page
            if (rec.actionType === 'update_phase' || rec.ctaLabel === 'View Tasks') {
              document.querySelector('[class*="phaseDetail"], [class*="PhaseDetail"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else if (rec.actionType === 'send_sms' || rec.actionType === 'send_email') {
              // Open the AI chatbot with a contextual prompt
              document.querySelector('[class*="chatFab"], [class*="AIChatbot"]')?.click();
            } else {
              // Default: expand evidence if available
              if (rec.evidence?.length > 0) setExpanded(true);
            }
          }}
        >
          {rec.ctaLabel}
        </button>

        {rec.evidence && rec.evidence.length > 0 && (
          <button
            className={s.evidenceToggle}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Hide details' : 'See evidence'}
          </button>
        )}
      </div>

      {expanded && rec.evidence && rec.evidence.length > 0 && (
        <div className={s.evidence}>
          {rec.evidence.map((e, i) => (
            <div key={i} className={s.evidenceItem}>{e}</div>
          ))}
          {rec.draftedContent && (
            <div className={s.draft}>
              &ldquo;{rec.draftedContent}&rdquo;
            </div>
          )}
        </div>
      )}
    </div>
  );
}
