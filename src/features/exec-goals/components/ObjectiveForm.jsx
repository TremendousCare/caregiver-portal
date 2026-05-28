import { useState } from 'react';
import { quarterRange } from '../lib/goalsHelpers';
import s from '../ExecGoalsPage.module.css';

const STATUSES = ['draft', 'active', 'achieved', 'missed', 'cancelled'];

export function ObjectiveForm({ initial, defaultQuarter, defaultOwner, onCancel, onSave, submitting }) {
  // Auto-populate start/end from the quarter so the owner rarely has
  // to touch them. They can override for cross-quarter goals.
  const initialQuarter = initial?.quarter ?? defaultQuarter ?? '';
  const { start: qStart, end: qEnd } = quarterRange(initialQuarter);

  const [title, setTitle]             = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [ownerEmail, setOwnerEmail]   = useState(initial?.owner_email ?? defaultOwner ?? '');
  const [quarter, setQuarter]         = useState(initialQuarter);
  const [startDate, setStartDate]     = useState(initial?.start_date ?? qStart ?? '');
  const [endDate, setEndDate]         = useState(initial?.end_date ?? qEnd ?? '');
  const [status, setStatus]           = useState(initial?.status ?? 'active');
  const [formError, setFormError]     = useState('');

  function handleQuarterChange(q) {
    setQuarter(q);
    // Re-snap dates to the new quarter, but only if the user hasn't
    // already deviated from the prior auto-fill (i.e. dates still
    // matched the prior quarter's range).
    const prior = quarterRange(quarter);
    if (startDate === prior.start) {
      const next = quarterRange(q);
      setStartDate(next.start ?? '');
    }
    if (endDate === prior.end) {
      const next = quarterRange(q);
      setEndDate(next.end ?? '');
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    try {
      await onSave({
        title,
        description,
        owner_email: ownerEmail,
        quarter,
        start_date: startDate,
        end_date: endDate,
        status,
      });
    } catch (err) {
      setFormError(err?.message ?? 'Could not save objective.');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {formError && <div className={s.error}>{formError}</div>}

      <div className={s.field}>
        <label className={s.fieldLabel}>Objective title</label>
        <input
          className={s.input}
          type="text"
          required
          autoFocus
          maxLength={200}
          placeholder='e.g. "Become the highest-rated home-care agency in OC"'
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Description (optional)</label>
        <textarea
          className={s.textarea}
          rows={3}
          placeholder="Context, why this matters, success criteria…"
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
            placeholder="owner@yourdomain.com"
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>Status</label>
          <select className={s.select} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((st) => (
              <option key={st} value={st}>{st}</option>
            ))}
          </select>
        </div>
      </div>

      <div className={s.threeCol}>
        <div className={s.field}>
          <label className={s.fieldLabel}>Quarter</label>
          <input
            className={s.input}
            type="text"
            required
            pattern="\d{4}-Q[1-4]"
            placeholder="YYYY-Q[1-4]"
            value={quarter}
            onChange={(e) => handleQuarterChange(e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>Start date</label>
          <input
            className={s.input}
            type="date"
            required
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>End date</label>
          <input
            className={s.input}
            type="date"
            required
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
      </div>

      <div className={s.modalActions}>
        <button type="button" className={s.secondaryBtn} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className={s.primaryBtn} disabled={submitting}>
          {submitting ? 'Saving…' : initial ? 'Save changes' : 'Create objective'}
        </button>
      </div>
    </form>
  );
}
