import { useState, useEffect } from 'react';
import { supabase } from '../../../lib/supabase';
import cards from '../../../styles/cards.module.css';

// ═══════════════════════════════════════════════════════════════
// Survey Results Section — shows on caregiver profile
//
// Fetches survey responses for this caregiver and displays:
// - Status badge (qualified/flagged/disqualified/pending)
// - Each question with their answer
// - Any qualification flags highlighted
// ═══════════════════════════════════════════════════════════════

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: '#A16207', bg: '#FFFBEB', border: '#FDE68A', icon: '⏳' },
  qualified: { label: 'Qualified', color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0', icon: '✅' },
  flagged: { label: 'Flagged', color: '#A16207', bg: '#FFFBEB', border: '#FDE68A', icon: '⚠️' },
  disqualified: { label: 'Disqualified', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA', icon: '🚫' },
};

export function SurveyResults({ caregiver }) {
  const [responses, setResponses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!supabase || !caregiver?.id) {
      setLoading(false);
      return;
    }

    supabase
      .from('survey_responses')
      .select('*, survey_templates(name, questions)')
      .eq('caregiver_id', caregiver.id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!error && data) setResponses(data);
        setLoading(false);
      });
  }, [caregiver?.id]);

  // Don't render the section if no surveys exist for this caregiver
  if (loading || responses.length === 0) return null;

  const latest = responses[0];
  const sc = STATUS_CONFIG[latest.status] || STATUS_CONFIG.pending;
  const questions = latest.survey_templates?.questions || [];
  const answers = latest.answers || {};
  const qualResults = latest.qualification_results || [];

  // Build a lookup for qualification results by question_id
  const qualByQuestion = {};
  for (const r of qualResults) {
    if (!qualByQuestion[r.question_id]) qualByQuestion[r.question_id] = [];
    qualByQuestion[r.question_id].push(r);
  }

  const sentDate = latest.sent_at ? new Date(latest.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const submittedDate = latest.submitted_at ? new Date(latest.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;

  return (
    <div className={cards.profileCard} style={{ marginBottom: 20 }}>
      <div
        className={cards.profileCardHeader}
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
          <h3 className={cards.profileCardTitle}>Pre-Screening Survey</h3>
          {/* Status badge inline with title */}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '4px 12px', borderRadius: 8,
            fontSize: 12, fontWeight: 700,
            background: sc.bg, color: sc.color, border: `1px solid ${sc.border}`,
          }}>
            {sc.icon} {sc.label}
          </span>
        </div>
        <span style={{ fontSize: 16, color: '#7A8BA0', transition: 'transform 0.2s', transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
          ▼
        </span>
      </div>

      {expanded && (
        <div style={{ padding: '20px 24px' }}>
          {/* Timestamps */}
          <div style={{ display: 'flex', gap: 20, marginBottom: 16, fontSize: 12, color: '#7A8BA0' }}>
            {sentDate && <span>Sent: <strong style={{ color: '#4B5563' }}>{sentDate}</strong></span>}
            {submittedDate && <span>Submitted: <strong style={{ color: '#4B5563' }}>{submittedDate}</strong></span>}
            {!submittedDate && latest.status === 'pending' && (
              <span style={{ color: '#A16207', fontWeight: 600 }}>Awaiting response</span>
            )}
          </div>

          {/* Disqualification/Flag banner */}
          {(latest.status === 'disqualified' || latest.status === 'flagged') && qualResults.length > 0 && (
            <div style={{
              background: latest.status === 'disqualified' ? '#FEF2F2' : '#FFFBEB',
              border: `1px solid ${latest.status === 'disqualified' ? '#FECACA' : '#FDE68A'}`,
              borderRadius: 10, padding: '12px 16px', marginBottom: 16,
            }}>
              <div style={{
                fontSize: 12, fontWeight: 700,
                color: latest.status === 'disqualified' ? '#DC2626' : '#A16207',
                marginBottom: 6,
                textTransform: 'uppercase', letterSpacing: 0.5,
              }}>
                {latest.status === 'disqualified' ? 'Disqualification Reasons' : 'Flagged Items'}
              </div>
              {qualResults.filter((r) => r.action !== 'pass').map((r, i) => (
                <div key={i} style={{ fontSize: 13, color: '#0F1724', marginBottom: 3 }}>
                  • {r.reason || r.question_text}: <strong>{r.answer}</strong>
                </div>
              ))}
            </div>
          )}

          {/* Questions and answers */}
          {latest.status !== 'pending' && questions.length > 0 && (
            <div style={{ border: '1px solid #E0E4EA', borderRadius: 12, overflow: 'hidden' }}>
              {questions.map((q, i) => {
                const answer = answers[q.id];
                const qResults = qualByQuestion[q.id] || [];
                const hasIssue = qResults.some((r) => r.action === 'disqualify' || r.action === 'flag');
                const isDisqualify = qResults.some((r) => r.action === 'disqualify');

                return (
                  <div
                    key={q.id}
                    style={{
                      display: 'grid', gridTemplateColumns: '1fr 1fr',
                      padding: '10px 16px', alignItems: 'center',
                      borderBottom: i < questions.length - 1 ? '1px solid #F0F3F7' : 'none',
                      background: hasIssue
                        ? (isDisqualify ? '#FEF2F2' : '#FFFBEB')
                        : (i % 2 === 0 ? '#fff' : '#FAFBFC'),
                    }}
                  >
                    <div style={{ fontSize: 13, color: '#4B5563', fontWeight: 500 }}>
                      {q.text}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        fontSize: 13, fontWeight: 600,
                        color: hasIssue ? (isDisqualify ? '#DC2626' : '#A16207') : '#0F1724',
                      }}>
                        {answer !== undefined && answer !== null ? String(answer) : '—'}
                      </span>
                      {hasIssue && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                          background: isDisqualify ? '#FECACA' : '#FDE68A',
                          color: isDisqualify ? '#DC2626' : '#A16207',
                        }}>
                          {isDisqualify ? 'DISQUALIFY' : 'FLAG'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
