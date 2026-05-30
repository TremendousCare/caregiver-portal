import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { validatePasswordChange } from '../../lib/passwordChange';
import s from './CaregiverPortal.module.css';

// Change-password screen for a signed-in caregiver. Re-authenticates with
// the current password (via signInWithPassword) before calling
// updateUser, so a borrowed/unlocked phone can't silently reset the
// password. Mirrors the 10-char minimum used everywhere else.
export function CaregiverChangePassword() {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const { tooShort, mismatch, sameAsOld, canSubmit } = validatePasswordChange({
    current,
    password,
    confirm,
  });
  const submittable = canSubmit && !busy;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!submittable) return;
    setBusy(true);
    setError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const email = sess?.session?.user?.email;
      if (!email) throw new Error('You’re signed out. Please sign back in and try again.');

      // Verify the current password by re-authenticating.
      const { error: reauthErr } = await supabase.auth.signInWithPassword({
        email,
        password: current,
      });
      if (reauthErr) throw new Error('Your current password is incorrect.');

      const { error: upErr } = await supabase.auth.updateUser({ password });
      if (upErr) throw upErr;
      setDone(true);
    } catch (err) {
      setError(err?.message || 'Could not change your password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.page}>
      <Link className={s.linkBtn} to="/care">← Back to shifts</Link>
      <section className={s.card}>
        <h1 className={s.title}>Change password</h1>
        {done ? (
          <>
            <div className={s.successBanner}>Your password has been changed.</div>
            <Link className={s.primaryBtnLarge} to="/care">Back to shifts</Link>
          </>
        ) : (
          <form onSubmit={handleSubmit} className={s.form}>
            <div>
              <label className={s.label} htmlFor="cg-current">Current password</label>
              <input
                id="cg-current"
                className={s.input}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                placeholder="Your current password"
              />
            </div>
            <div>
              <label className={s.label} htmlFor="cg-new">New password</label>
              <input
                id="cg-new"
                className={s.input}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 10 characters"
              />
            </div>
            <div>
              <label className={s.label} htmlFor="cg-confirm">Confirm new password</label>
              <input
                id="cg-confirm"
                className={s.input}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter your new password"
              />
            </div>
            {tooShort && <p className={s.error}>Password must be at least 10 characters.</p>}
            {mismatch && <p className={s.error}>New passwords don’t match.</p>}
            {sameAsOld && <p className={s.error}>New password must be different from your current one.</p>}
            {error && <p className={s.error}>{error}</p>}
            <button className={s.primaryBtnLarge} type="submit" disabled={!submittable}>
              {busy ? 'Saving…' : 'Change password'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
