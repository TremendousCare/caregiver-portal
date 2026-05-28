import { useMemo, useState } from 'react';
import { mondayOf } from '../lib/goalsHelpers';
import s from '../ExecGoalsPage.module.css';

export function CheckinForm({ kr, onCancel, onSave, submitting }) {
  const defaultWeek = useMemo(() => mondayOf(new Date()), []);
  const [weekOf, setWeekOf]         = useState(defaultWeek);
  const [value, setValue]           = useState(kr?.current_value ?? '');
  const [confidence, setConfidence] = useState(kr?.confidence ?? 'green');
  const [note, setNote]             = useState('');
  const [formError, setFormError]   = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    try {
      await onSave({
        key_result_id: kr.id,
        week_of: weekOf,
        value,
        confidence,
        note,
      });
    } catch (err) {
      setFormError(err?.message ?? 'Could not save check-in.');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {formError && <div className={s.error}>{formError}</div>}

      <div className={s.field}>
        <label className={s.fieldLabel}>Key result</label>
        <div style={{ fontSize: 14, fontWeight: 600, padding: '8px 0' }}>{kr?.title}</div>
      </div>

      <div className={s.twoCol}>
        <div className={s.field}>
          <label className={s.fieldLabel}>Week of (Monday)</label>
          <input
            className={s.input}
            type="date"
            required
            value={weekOf}
            onChange={(e) => setWeekOf(e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>Current value</label>
          <input
            className={s.input}
            type="number"
            step="any"
            required
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Confidence</label>
        <div className={s.confidenceRadio}>
          {[
            { v: 'green',  label: 'Green — on track', cls: s.selectedGreen },
            { v: 'yellow', label: 'Yellow — at risk', cls: s.selectedYellow },
            { v: 'red',    label: 'Red — off track',  cls: s.selectedRed },
          ].map((opt) => (
            <label key={opt.v} className={confidence === opt.v ? opt.cls : ''}>
              <input
                type="radio"
                name="confidence"
                value={opt.v}
                checked={confidence === opt.v}
                onChange={() => setConfidence(opt.v)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>What moved the needle? (optional)</label>
        <textarea
          className={s.textarea}
          rows={3}
          placeholder="What helped progress? What's blocking? Capture context so the quarterly retro has signal."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className={s.modalActions}>
        <button type="button" className={s.secondaryBtn} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className={s.primaryBtn} disabled={submitting}>
          {submitting ? 'Saving…' : 'Save check-in'}
        </button>
      </div>
    </form>
  );
}
