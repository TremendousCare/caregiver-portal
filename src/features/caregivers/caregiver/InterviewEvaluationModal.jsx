import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import {
  validateRequiredAnswers,
  extractProfileFieldUpdates,
  evaluateSurveyAnswers,
  prefillAnswersFromCaregiver,
  generateSurveyToken,
  INTERVIEW_WRITEBACK_FIELDS,
} from '../../../lib/surveyUtils';
import { QuestionField } from '../../survey/SurveyPage';

// Internal evaluation form rendered inside a modal inside an authenticated
// admin session. Reuses the existing survey_templates / survey_responses
// infrastructure so the template is editable from Settings without code
// changes. Unlike the public /survey/:token flow, this one:
//   - loads the template by id (not by token)
//   - writes directly to caregivers (authenticated RLS, no edge function)
//   - auto-completes the linked phase task on submit
//   - logs an event for the AI context layer
export function InterviewEvaluationModal({
  isOpen,
  caregiver,
  templateId,
  taskId,
  currentUser,
  onClose,
  onUpdateTask,
  showToast,
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [template, setTemplate] = useState(null);
  const [prior, setPrior] = useState(null);
  const [answers, setAnswers] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [readOnly, setReadOnly] = useState(false);

  // Load template + most recent prior response when opened
  useEffect(() => {
    if (!isOpen || !templateId || !supabase) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setReadOnly(false);
    (async () => {
      try {
        const [{ data: tpl, error: tplErr }, { data: respRows, error: respErr }] = await Promise.all([
          supabase.from('survey_templates').select('*').eq('id', templateId).single(),
          supabase
            .from('survey_responses')
            .select('*')
            .eq('survey_template_id', templateId)
            .eq('caregiver_id', caregiver.id)
            .order('submitted_at', { ascending: false, nullsFirst: false })
            .limit(1),
        ]);
        if (cancelled) return;
        if (tplErr || !tpl) {
          setLoadError('Could not load the interview template.');
          return;
        }
        setTemplate(tpl);
        const priorRow = !respErr && Array.isArray(respRows) && respRows[0] ? respRows[0] : null;
        setPrior(priorRow);
        if (priorRow?.submitted_at) {
          setAnswers(priorRow.answers || {});
          setReadOnly(true);
        } else {
          setAnswers({
            ...prefillAnswersFromCaregiver(tpl.questions || [], caregiver),
            ...(priorRow?.answers || {}),
          });
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[InterviewEvaluation] load failed', err);
          setLoadError('Something went wrong loading the form.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, templateId, caregiver?.id]);

  const questions = template?.questions || [];

  const setAnswer = useCallback((qid, value) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }));
    setFieldErrors((prev) => {
      if (!prev[qid]) return prev;
      const next = { ...prev };
      delete next[qid];
      return next;
    });
  }, []);

  const groupedBySection = useMemo(() => {
    const groups = [];
    let current = null;
    questions.forEach((q, i) => {
      const section = q.section || '';
      if (!current || current.section !== section) {
        current = { section, items: [] };
        groups.push(current);
      }
      current.items.push({ q, index: i });
    });
    return groups;
  }, [questions]);

  const handleSubmit = useCallback(async () => {
    if (!template || submitting || !supabase) return;

    const missing = validateRequiredAnswers(questions, answers);
    if (missing.length > 0) {
      const errs = {};
      for (const id of missing) errs[id] = 'Required';
      setFieldErrors(errs);
      return;
    }

    setSubmitting(true);
    try {
      const { status, results } = evaluateSurveyAnswers(questions, answers);

      // 1. Persist the response row. Each submission is a new row — history
      //    is preserved so TAS can see how an evaluation changed if the form
      //    is ever re-opened and saved.
      const token = generateSurveyToken();
      const { error: insertErr } = await supabase.from('survey_responses').insert({
        survey_template_id: template.id,
        caregiver_id: caregiver.id,
        token,
        answers,
        status,
        qualification_results: results,
        sent_via: 'internal',
        submitted_at: new Date().toISOString(),
      });
      if (insertErr) throw insertErr;

      // 2. Write mapped answers back to the caregiver profile. Filtered to
      //    an allow-list so a mis-edited template can't clobber unrelated
      //    columns.
      const mapped = extractProfileFieldUpdates(questions, answers);
      const safeUpdates = {};
      for (const [k, v] of Object.entries(mapped)) {
        if (!INTERVIEW_WRITEBACK_FIELDS.has(k)) continue;
        if (k === 'proposed_pay_rate') {
          const num = parseFloat(v);
          if (Number.isFinite(num)) safeUpdates[k] = num;
        } else {
          safeUpdates[k] = v;
        }
      }
      if (Object.keys(safeUpdates).length > 0) {
        const { error: updErr } = await supabase
          .from('caregivers')
          .update(safeUpdates)
          .eq('id', caregiver.id);
        if (updErr) console.warn('[InterviewEvaluation] profile write-back failed', updErr);
      }

      // 3. Auto-complete the linked phase task (optional — skip if the form
      //    isn't wired to a task).
      if (taskId && onUpdateTask) {
        onUpdateTask(caregiver.id, taskId, true);
      }

      // 4. Fire-and-forget event for the AI context layer
      supabase
        .from('events')
        .insert({
          event_type: 'interview_evaluation_completed',
          entity_type: 'caregiver',
          entity_id: caregiver.id,
          actor: currentUser?.displayName ? `user:${currentUser.displayName}` : 'user:unknown',
          payload: { template_id: template.id, status, task_id: taskId || null },
        })
        .then(({ error }) => { if (error) console.warn('[InterviewEvaluation] event log failed', error.message); });

      showToast?.('Interview evaluation saved.');
      onClose?.();
    } catch (err) {
      console.error('[InterviewEvaluation] submit failed', err);
      setFieldErrors({ _form: 'Could not save. Please try again.' });
    } finally {
      setSubmitting(false);
    }
  }, [template, questions, answers, submitting, caregiver, taskId, onUpdateTask, onClose, currentUser, showToast]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#fff', borderRadius: 16, width: '100%', maxWidth: 720,
          maxHeight: '90vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '20px 24px 12px', borderBottom: '1px solid #E5E7EB',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
        }}>
          <div>
            <h3 style={{ margin: 0, fontFamily: 'var(--tc-font-heading)', fontSize: 20, fontWeight: 700, color: '#1A1A1A' }}>
              {template?.name || 'Interview Evaluation'}
            </h3>
            <div style={{ fontSize: 13, color: '#6B7B8F', marginTop: 4 }}>
              {caregiver.firstName} {caregiver.lastName}
              {readOnly && (
                <span style={{
                  marginLeft: 10, padding: '2px 8px', borderRadius: 999,
                  background: '#F0FDF4', border: '1px solid #BBF7D0', color: '#15803D',
                  fontSize: 11, fontWeight: 700,
                }}>
                  Submitted {prior?.submitted_at ? new Date(prior.submitted_at).toLocaleDateString() : ''}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', fontSize: 22, lineHeight: 1,
              color: '#6B7B8F', cursor: 'pointer', padding: 4,
            }}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '16px 24px', overflowY: 'auto', flex: 1 }}>
          {loading && <div style={{ padding: 40, textAlign: 'center', color: '#6B7B8F' }}>Loading form...</div>}
          {loadError && (
            <div style={{
              background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10,
              padding: '12px 16px', color: '#DC2626', fontSize: 13,
            }}>{loadError}</div>
          )}
          {!loading && !loadError && groupedBySection.map(({ section, items }, gi) => (
            <div key={gi} style={{ marginBottom: 12 }}>
              {section && (
                <div style={{
                  fontSize: 12, fontWeight: 700, color: '#2E4E8D', textTransform: 'uppercase',
                  letterSpacing: 0.8, margin: '12px 0 6px', paddingBottom: 4,
                  borderBottom: '1px solid #E5E7EB',
                }}>{section}</div>
              )}
              {items.map(({ q, index }) => (
                <div
                  key={q.id}
                  style={readOnly ? { pointerEvents: 'none', opacity: 0.85 } : undefined}
                >
                  <QuestionField
                    question={q}
                    index={index}
                    value={answers[q.id]}
                    error={fieldErrors[q.id]}
                    onChange={(val) => setAnswer(q.id, val)}
                  />
                </div>
              ))}
            </div>
          ))}
          {fieldErrors._form && (
            <div style={{
              background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10,
              padding: '12px 16px', marginTop: 12, color: '#DC2626', fontSize: 13, fontWeight: 500,
            }}>{fieldErrors._form}</div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 24px 18px', borderTop: '1px solid #E5E7EB',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px', borderRadius: 8, border: '1px solid #D1D5DB',
              background: '#fff', color: '#374151', fontWeight: 600, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 13,
            }}
          >
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly && (
            <button
              onClick={handleSubmit}
              disabled={submitting || loading || !!loadError}
              style={{
                padding: '8px 20px', borderRadius: 8, border: 'none',
                background: submitting ? '#94A3B8' : 'var(--tc-cyan, #29BEE4)',
                color: '#fff', fontWeight: 700, cursor: submitting ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit', fontSize: 13,
              }}
            >
              {submitting ? 'Saving...' : 'Submit Evaluation'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
