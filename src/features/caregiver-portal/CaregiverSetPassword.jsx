import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import s from './CaregiverPortal.module.css';

// Shown after a caregiver clicks a password-reset email link.
// Supabase fires a PASSWORD_RECOVERY auth event which leaves the user
// in a session that can only be used to call updateUser({ password }).
// After the update succeeds we clear the recovery flag and the app
// continues into the normal signed-in view.

export function CaregiverSetPassword({ onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 10) {
      setError('Password must be at least 10 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const { error: updErr } = await supabase.auth.updateUser({ password });
      if (updErr) throw updErr;
      onDone?.();
    } catch (err) {
      setError(err?.message || 'Could not update password. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={s.centered}>
      <form className={s.card} onSubmit={handleSubmit}>
        <h1 className={s.title}>Set a new password</h1>
        <p className={s.muted}>Choose a password you&rsquo;ll remember. 10 characters or more.</p>
        <label className={s.label} htmlFor="cg-new-pw">New password</label>
        <input
          id="cg-new-pw"
          type="password"
          autoComplete="new-password"
          className={s.input}
          value={password}
          onChange={(ev) => setPassword(ev.target.value)}
          required
        />
        <label className={s.label} htmlFor="cg-new-pw2">Confirm password</label>
        <input
          id="cg-new-pw2"
          type="password"
          autoComplete="new-password"
          className={s.input}
          value={confirm}
          onChange={(ev) => setConfirm(ev.target.value)}
          required
        />
        {error && <div className={s.error}>{error}</div>}
        <button type="submit" className={s.primaryBtn} disabled={submitting}>
          {submitting ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </div>
  );
}
