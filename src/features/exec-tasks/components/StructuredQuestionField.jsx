import s from '../ExecTasksPage.module.css';

// Renders one field of a template's structured_questions array. Eight
// types supported by Phase 3:
//   rating_1_5, short_text, long_text, yes_no, single_select, number,
//   date, multi_text (free-form list, comma-separated).
//
// Controlled component: receives value + onChange, never touches its
// own state. The parent owns the responses object keyed by question id.

export function StructuredQuestionField({ question, value, onChange, disabled }) {
  const id = `q-${question.id}`;
  const requiredMark = question.required ? <span className={s.questionRequired} aria-hidden="true">*</span> : null;

  function handleChange(e) {
    onChange?.(e.target?.value ?? e);
  }

  return (
    <div className={s.questionBlock}>
      <label className={s.questionLabel} htmlFor={id}>
        {question.label}{requiredMark}
      </label>

      {question.type === 'short_text' && (
        <input
          id={id}
          type="text"
          className={s.input}
          value={value ?? ''}
          onChange={handleChange}
          disabled={disabled}
          required={!!question.required}
        />
      )}

      {question.type === 'long_text' && (
        <textarea
          id={id}
          rows={3}
          className={s.textarea}
          value={value ?? ''}
          onChange={handleChange}
          disabled={disabled}
          required={!!question.required}
        />
      )}

      {question.type === 'number' && (
        <input
          id={id}
          type="number"
          step="any"
          className={s.input}
          value={value ?? ''}
          onChange={handleChange}
          disabled={disabled}
          required={!!question.required}
        />
      )}

      {question.type === 'date' && (
        <input
          id={id}
          type="date"
          className={s.input}
          value={value ?? ''}
          onChange={handleChange}
          disabled={disabled}
          required={!!question.required}
        />
      )}

      {question.type === 'yes_no' && (
        <select
          id={id}
          className={s.select}
          value={value ?? ''}
          onChange={handleChange}
          disabled={disabled}
          required={!!question.required}
        >
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      )}

      {question.type === 'single_select' && (
        <select
          id={id}
          className={s.select}
          value={value ?? ''}
          onChange={handleChange}
          disabled={disabled}
          required={!!question.required}
        >
          <option value="">—</option>
          {(question.options ?? []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )}

      {question.type === 'rating_1_5' && (
        <select
          id={id}
          className={s.select}
          value={value ?? ''}
          onChange={handleChange}
          disabled={disabled}
          required={!!question.required}
        >
          <option value="">—</option>
          <option value="1">1 — far below expectations</option>
          <option value="2">2 — below expectations</option>
          <option value="3">3 — meeting expectations</option>
          <option value="4">4 — exceeding</option>
          <option value="5">5 — far exceeding</option>
        </select>
      )}

      {/* Fallback: unknown types render a short_text input so the
          form never breaks if a template introduces a new type
          ahead of the UI knowing about it. */}
      {![
        'short_text', 'long_text', 'number', 'date',
        'yes_no', 'single_select', 'rating_1_5',
      ].includes(question.type) && (
        <input
          id={id}
          type="text"
          className={s.input}
          value={value ?? ''}
          onChange={handleChange}
          disabled={disabled}
        />
      )}
    </div>
  );
}
