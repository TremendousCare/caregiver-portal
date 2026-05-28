import { useState } from 'react';
import { StructuredQuestionField } from './StructuredQuestionField';
import s from '../ExecTasksPage.module.css';

export function CompleteTaskForm({ task, onCancel, onSubmit, submitting }) {
  const questions = task?.exec_task_templates?.structured_questions ?? [];
  const [responses, setResponses] = useState(task.structured_responses ?? {});
  const [notes, setNotes] = useState(task.completion_notes ?? '');
  const [outcome, setOutcome] = useState(task.outcome ?? '');
  const [formError, setFormError] = useState('');

  function updateResponse(qid, value) {
    setResponses((prev) => ({ ...prev, [qid]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    try {
      await onSubmit({
        structuredResponses: responses,
        completionNotes: notes,
        outcome: outcome === '' ? null : outcome,
        questions,
      });
    } catch (err) {
      setFormError(err?.message ?? 'Could not save completion.');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {formError && <div className={s.error}>{formError}</div>}

      {questions.length === 0 ? (
        <div style={{ fontSize: 13, color: '#5A6B85', padding: '4px 0 12px' }}>
          This task has no structured questions — leave a completion note below and you&rsquo;re done.
        </div>
      ) : (
        questions.map((q) => (
          <StructuredQuestionField
            key={q.id}
            question={q}
            value={responses[q.id]}
            onChange={(val) => updateResponse(q.id, val)}
            disabled={submitting}
          />
        ))
      )}

      <div className={s.field}>
        <label className={s.fieldLabel}>Completion notes (optional)</label>
        <textarea
          className={s.textarea}
          rows={2}
          placeholder="Anything not captured by the questions above…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Overall outcome (optional)</label>
        <div className={s.outcomeRadio}>
          {[
            { v: 'on_track',       label: 'On track',        cls: s.selectedOnTrack },
            { v: 'needs_support',  label: 'Needs support',   cls: s.selectedNeedsSupport },
            { v: 'concern',        label: 'Concern',         cls: s.selectedConcern },
          ].map((opt) => (
            <label key={opt.v} className={outcome === opt.v ? opt.cls : ''}>
              <input
                type="radio"
                name="outcome"
                value={opt.v}
                checked={outcome === opt.v}
                onChange={() => setOutcome(opt.v)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>

      <div className={s.modalActions}>
        <button type="button" className={s.secondaryBtn} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className={s.primaryBtn} disabled={submitting}>
          {submitting ? 'Saving…' : 'Mark complete'}
        </button>
      </div>
    </form>
  );
}
