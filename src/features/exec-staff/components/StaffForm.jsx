import { useState } from 'react';
import s from '../ExecStaffPage.module.css';

export function StaffForm({ initial, submitting, onCancel, onSave }) {
  const [email, setEmail]           = useState(initial?.email ?? '');
  const [firstName, setFirstName]   = useState(initial?.first_name ?? '');
  const [lastName, setLastName]     = useState(initial?.last_name ?? '');
  const [roleTitle, setRoleTitle]   = useState(initial?.role_title ?? '');
  const [managerEmail, setManagerEmail] = useState(initial?.manager_email ?? '');
  const [hireDate, setHireDate]     = useState(initial?.hire_date ?? '');
  const [endDate, setEndDate]       = useState(initial?.end_date ?? '');
  const [active, setActive]         = useState(initial?.active !== false);
  const [notes, setNotes]           = useState(initial?.notes ?? '');
  const [formError, setFormError]   = useState('');

  // When the user flips active OFF, suggest end_date = today.
  // Owner can override or clear; we don't enforce.
  function handleActiveToggle(checked) {
    setActive(checked);
    if (!checked && !endDate) {
      const t = new Date();
      const yyyy = t.getFullYear();
      const mm = String(t.getMonth() + 1).padStart(2, '0');
      const dd = String(t.getDate()).padStart(2, '0');
      setEndDate(`${yyyy}-${mm}-${dd}`);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    try {
      await onSave({
        email,
        first_name: firstName,
        last_name: lastName,
        role_title: roleTitle,
        manager_email: managerEmail,
        hire_date: hireDate,
        end_date: endDate || null,
        active,
        notes,
      });
    } catch (err) {
      setFormError(err?.message ?? 'Could not save staff member.');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {formError && <div className={s.error}>{formError}</div>}

      <div className={s.twoCol}>
        <div className={s.field}>
          <label className={s.fieldLabel}>First name</label>
          <input
            className={s.input}
            type="text"
            required
            autoFocus={!initial}
            maxLength={100}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>Last name</label>
          <input
            className={s.input}
            type="text"
            maxLength={100}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Email</label>
        <input
          className={s.input}
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="staff@yourdomain.com"
        />
      </div>

      <div className={s.twoCol}>
        <div className={s.field}>
          <label className={s.fieldLabel}>Role / title</label>
          <input
            className={s.input}
            type="text"
            maxLength={100}
            value={roleTitle}
            onChange={(e) => setRoleTitle(e.target.value)}
            placeholder='e.g. "BD Rep", "Office Manager"'
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>Manager email (optional)</label>
          <input
            className={s.input}
            type="email"
            value={managerEmail}
            onChange={(e) => setManagerEmail(e.target.value)}
            placeholder="manager@yourdomain.com"
          />
        </div>
      </div>

      <div className={s.twoCol}>
        <div className={s.field}>
          <label className={s.fieldLabel}>Hire date</label>
          <input
            className={s.input}
            type="date"
            required
            value={hireDate}
            onChange={(e) => setHireDate(e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>End date (if applicable)</label>
          <input
            className={s.input}
            type="date"
            value={endDate || ''}
            onChange={(e) => setEndDate(e.target.value)}
            min={hireDate || undefined}
          />
        </div>
      </div>

      <label className={s.checkboxField} style={{ marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => handleActiveToggle(e.target.checked)}
        />
        Active employee
      </label>

      <div className={s.field}>
        <label className={s.fieldLabel}>Notes (optional)</label>
        <textarea
          className={s.textarea}
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth remembering — accommodations, work schedule, etc."
        />
      </div>

      <div className={s.modalActions}>
        <button type="button" className={s.secondaryBtn} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className={s.primaryBtn} disabled={submitting}>
          {submitting ? 'Saving…' : initial ? 'Save changes' : 'Add staff member'}
        </button>
      </div>
    </form>
  );
}
