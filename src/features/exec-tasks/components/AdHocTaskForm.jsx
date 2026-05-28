import { useState } from 'react';
import s from '../ExecTasksPage.module.css';

export function AdHocTaskForm({ defaultAssignee, submitting, onCancel, onSave }) {
  const [title, setTitle]           = useState('');
  const [description, setDescription] = useState('');
  const [assignedTo, setAssignedTo] = useState(defaultAssignee ?? '');
  const [dueAt, setDueAt]           = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString().slice(0, 16); // datetime-local format
  });
  const [urgency, setUrgency]       = useState('warning');
  const [formError, setFormError]   = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    try {
      // Convert datetime-local (no TZ) → ISO with UTC suffix. The DB
      // stores timestamptz so a normalized UTC ISO is the safest input.
      const dueAtIso = dueAt ? new Date(dueAt).toISOString() : null;
      await onSave({
        title,
        description,
        assigned_to: assignedTo,
        due_at: dueAtIso,
        urgency,
      });
    } catch (err) {
      setFormError(err?.message ?? 'Could not create task.');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {formError && <div className={s.error}>{formError}</div>}

      <div className={s.field}>
        <label className={s.fieldLabel}>Task title</label>
        <input
          className={s.input}
          type="text"
          required
          autoFocus
          maxLength={200}
          placeholder='e.g. "Review month-end vendor invoices"'
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Description (optional)</label>
        <textarea
          className={s.textarea}
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className={s.twoCol}>
        <div className={s.field}>
          <label className={s.fieldLabel}>Assigned to (email)</label>
          <input
            className={s.input}
            type="email"
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            placeholder="Leave blank to notify all owners"
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>Urgency</label>
          <select className={s.select} value={urgency} onChange={(e) => setUrgency(e.target.value)}>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </div>
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Due</label>
        <input
          className={s.input}
          type="datetime-local"
          required
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
        />
      </div>

      <div className={s.modalActions}>
        <button type="button" className={s.secondaryBtn} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className={s.primaryBtn} disabled={submitting}>
          {submitting ? 'Creating…' : 'Create task'}
        </button>
      </div>
    </form>
  );
}
