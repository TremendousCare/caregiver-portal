import { useState } from 'react';
import s from '../ExecGoalsPage.module.css';

const UNITS = [
  { value: 'count',   label: 'Count' },
  { value: 'percent', label: 'Percent (%)' },
  { value: 'dollars', label: 'Dollars ($)' },
  { value: 'rating',  label: 'Rating' },
  { value: 'other',   label: 'Other' },
];

export function KeyResultForm({ initial, goalId, defaultOwner, onCancel, onSave, submitting }) {
  const [title, setTitle]             = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [ownerEmail, setOwnerEmail]   = useState(initial?.owner_email ?? defaultOwner ?? '');
  const [metricUnit, setMetricUnit]   = useState(initial?.metric_unit ?? 'count');
  const [direction, setDirection]     = useState(initial?.direction ?? 'increase');
  const [startValue, setStartValue]   = useState(initial?.start_value ?? 0);
  const [currentValue, setCurrentValue] = useState(initial?.current_value ?? 0);
  const [targetValue, setTargetValue] = useState(initial?.target_value ?? '');
  const [formError, setFormError]     = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    try {
      await onSave({
        goal_id: initial?.goal_id ?? goalId,
        title,
        description,
        owner_email: ownerEmail,
        metric_unit: metricUnit,
        direction,
        start_value: startValue,
        current_value: currentValue,
        target_value: targetValue,
      });
    } catch (err) {
      setFormError(err?.message ?? 'Could not save key result.');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {formError && <div className={s.error}>{formError}</div>}

      <div className={s.field}>
        <label className={s.fieldLabel}>Key result title</label>
        <input
          className={s.input}
          type="text"
          required
          autoFocus
          maxLength={200}
          placeholder='e.g. "Achieve 4.8★ average Google review"'
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Description (optional)</label>
        <textarea
          className={s.textarea}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className={s.twoCol}>
        <div className={s.field}>
          <label className={s.fieldLabel}>Owner email</label>
          <input
            className={s.input}
            type="email"
            required
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>Direction</label>
          <select className={s.select} value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="increase">Increase (current → higher)</option>
            <option value="decrease">Decrease (current → lower)</option>
          </select>
        </div>
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Metric unit</label>
        <select className={s.select} value={metricUnit} onChange={(e) => setMetricUnit(e.target.value)}>
          {UNITS.map((u) => (
            <option key={u.value} value={u.value}>{u.label}</option>
          ))}
        </select>
      </div>

      <div className={s.threeCol}>
        <div className={s.field}>
          <label className={s.fieldLabel}>Start value</label>
          <input
            className={s.input}
            type="number"
            step="any"
            value={startValue}
            onChange={(e) => setStartValue(e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>Current value</label>
          <input
            className={s.input}
            type="number"
            step="any"
            value={currentValue}
            onChange={(e) => setCurrentValue(e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>Target value</label>
          <input
            className={s.input}
            type="number"
            step="any"
            required
            value={targetValue}
            onChange={(e) => setTargetValue(e.target.value)}
          />
        </div>
      </div>

      <div className={s.modalActions}>
        <button type="button" className={s.secondaryBtn} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className={s.primaryBtn} disabled={submitting}>
          {submitting ? 'Saving…' : initial ? 'Save changes' : 'Add key result'}
        </button>
      </div>
    </form>
  );
}
