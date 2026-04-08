import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { evaluateSurveyAnswers, validateRequiredAnswers } from '../../lib/surveyUtils';
import s from './SurveyPage.module.css';

// ═══════════════════════════════════════════════════════════════
// Public Survey Page
//
// Caregivers access this via a unique token link (no login needed).
// Flow: validate token → load survey → collect answers → submit
// On submit, the qualification engine scores answers and updates
// the survey response status (qualified/flagged/disqualified).
// ═══════════════════════════════════════════════════════════════

export function SurveyPage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [survey, setSurvey] = useState(null);       // survey_templates row
  const [response, setResponse] = useState(null);    // survey_responses row
  const [answers, setAnswers] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Validate token and load survey on mount
  useEffect(() => {
    if (!token || !supabase) {
      setError('Invalid survey link.');
      setLoading(false);
      return;
    }

    const load = async () => {
      try {
        // Fetch the survey response by token, join with template
        const { data: resp, error: respErr } = await supabase
          .from('survey_responses')
          .select('*, survey_templates(*)')
          .eq('token', token)
          .single();

        if (respErr || !resp) {
          setError('This survey link is invalid or has expired.');
          return;
        }

        // Check if already submitted
        if (resp.status !== 'pending') {
          setSubmitted(true);
          setResponse(resp);
          setSurvey(resp.survey_templates);
          return;
        }

        // Check expiration
        if (resp.expires_at && new Date(resp.expires_at) < new Date()) {
          setError('This survey has expired. Please contact us for a new link.');
          return;
        }

        setSurvey(resp.survey_templates);
        setResponse(resp);
        // Pre-fill any existing partial answers
        setAnswers(resp.answers || {});
      } catch (err) {
        console.error('Failed to load survey:', err);
        setError('Something went wrong loading the survey. Please try again.');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [token]);

  const setAnswer = useCallback((questionId, value) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    setFieldErrors((prev) => {
      if (!prev[questionId]) return prev;
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!survey || !response || submitting) return;

    const questions = survey.questions || [];

    // Validate required answers
    const missing = validateRequiredAnswers(questions, answers);
    if (missing.length > 0) {
      const errors = {};
      for (const qId of missing) errors[qId] = 'This question is required.';
      setFieldErrors(errors);
      // Scroll to first error
      const firstMissing = document.querySelector(`[data-question="${missing[0]}"]`);
      firstMissing?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    setSubmitting(true);
    try {
      // Run qualification engine
      const { status, results } = evaluateSurveyAnswers(questions, answers);

      // Update the response in the database
      const { error: updateErr } = await supabase
        .from('survey_responses')
        .update({
          answers,
          status,
          qualification_results: results,
          submitted_at: new Date().toISOString(),
        })
        .eq('id', response.id);

      if (updateErr) throw updateErr;

      setSubmitted(true);
    } catch (err) {
      console.error('Failed to submit survey:', err);
      setFieldErrors({ _form: 'Something went wrong. Please try again.' });
    } finally {
      setSubmitting(false);
    }
  }, [survey, response, answers, submitting]);

  // ── Loading State ──
  if (loading) {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <div className={s.logo}>
            Tremendous <span className={s.logoAccent}>Care</span>
          </div>
        </div>
        <div className={s.card}>
          <div className={s.loading}>
            <div className={s.spinner} />
            <div className={s.loadingText}>Loading survey...</div>
          </div>
        </div>
      </div>
    );
  }

  // ── Error State ──
  if (error) {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <div className={s.logo}>
            Tremendous <span className={s.logoAccent}>Care</span>
          </div>
        </div>
        <div className={s.card}>
          <div className={s.error}>
            <div className={s.errorIcon}>!</div>
            <h2 className={s.errorTitle}>Survey Unavailable</h2>
            <p className={s.errorText}>{error}</p>
          </div>
        </div>
        <div className={s.footer}>Tremendous Care &middot; Home Care Staffing</div>
      </div>
    );
  }

  // ── Success State (submitted) ──
  if (submitted) {
    return (
      <div className={s.page}>
        <div className={s.header}>
          <div className={s.logo}>
            Tremendous <span className={s.logoAccent}>Care</span>
          </div>
        </div>
        <div className={s.card}>
          <div className={s.success}>
            <div className={s.successIcon}>&#10003;</div>
            <h2 className={s.successTitle}>Thank You!</h2>
            <p className={s.successText}>
              Your responses have been submitted. Our team will review your
              information and be in touch soon.
            </p>
          </div>
        </div>
        <div className={s.footer}>Tremendous Care &middot; Home Care Staffing</div>
      </div>
    );
  }

  // ── Survey Form ──
  const questions = survey?.questions || [];
  const answeredCount = questions.filter((q) => {
    const a = answers[q.id];
    return a !== undefined && a !== null && String(a).trim() !== '';
  }).length;

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div className={s.logo}>
          Tremendous <span className={s.logoAccent}>Care</span>
        </div>
        <h1 className={s.title}>{survey?.name || 'Pre-Screening Survey'}</h1>
        {survey?.description && <p className={s.subtitle}>{survey.description}</p>}
      </div>

      {/* Progress bar */}
      {questions.length > 0 && (
        <div className={s.progressBar}>
          <div className={s.progressTrack}>
            <div
              className={s.progressFill}
              style={{ width: `${Math.round((answeredCount / questions.length) * 100)}%` }}
            />
          </div>
          <div className={s.progressLabel}>
            {answeredCount} of {questions.length} answered
          </div>
        </div>
      )}

      <div className={s.card}>
        {questions.map((q, i) => (
          <QuestionField
            key={q.id}
            question={q}
            index={i}
            value={answers[q.id]}
            error={fieldErrors[q.id]}
            onChange={(val) => setAnswer(q.id, val)}
          />
        ))}

        {fieldErrors._form && (
          <div style={{
            background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10,
            padding: '12px 16px', marginTop: 16, fontSize: 13, color: '#DC2626', fontWeight: 500,
          }}>
            {fieldErrors._form}
          </div>
        )}

        <button
          className={s.submitBtn}
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? 'Submitting...' : 'Submit Survey'}
        </button>
      </div>

      <div className={s.footer}>Tremendous Care &middot; Home Care Staffing</div>
    </div>
  );
}

// ── Question Field Component ──

function QuestionField({ question, index, value, error, onChange }) {
  const { id, text, type, required, options } = question;

  return (
    <div className={s.question} data-question={id}>
      <div className={s.questionHeader}>
        <span className={s.questionNumber}>{index + 1}</span>
        <span className={s.questionText}>
          {text}
          {required && <span className={s.required}>*</span>}
        </span>
      </div>

      {/* Yes/No and Multiple Choice */}
      {(type === 'yes_no' || type === 'multiple_choice') && (
        <div className={s.options}>
          {(options || []).map((opt) => {
            const selected = value === opt;
            return (
              <div
                key={opt}
                className={`${s.option} ${selected ? s.optionSelected : ''}`}
                onClick={() => onChange(opt)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(opt); } }}
              >
                <div className={`${s.optionRadio} ${selected ? s.optionRadioSelected : ''}`}>
                  {selected && <div className={s.optionRadioDot} />}
                </div>
                <span className={s.optionLabel}>{opt}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Free Text */}
      {type === 'free_text' && (
        <textarea
          className={`${s.textarea} ${error ? s.inputError : ''}`}
          placeholder="Type your answer here..."
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {/* Number */}
      {type === 'number' && (
        <input
          type="number"
          className={`${s.input} ${error ? s.inputError : ''}`}
          placeholder="Enter a number"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {error && <div className={s.fieldError}>{error}</div>}
    </div>
  );
}
