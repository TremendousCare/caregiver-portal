import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import s from './CaregiverPortal.module.css';

export function CaregiverLogin() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!email.trim()) {
      setError('Please enter your email.');
      return;
    }
    setSubmitting(true);
    try {
      const { error: signInErr } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          // Land the user back on /care after clicking the email link.
          emailRedirectTo: `${window.location.origin}/care`,
        },
      });
      if (signInErr) throw signInErr;
      setSent(true);
    } catch (err) {
      setError(err?.message || 'Could not send the link. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className={s.centered}>
        <div className={s.card}>
          <h1 className={s.title}>Check your email</h1>
          <p className={s.muted}>
            We sent a sign-in link to <strong>{email}</strong>. Tap the link on
            your phone to open the app.
          </p>
          <button
            type="button"
            className={s.secondaryBtn}
            onClick={() => { setSent(false); setEmail(''); }}
          >
            Use a different email
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={s.centered}>
      <form className={s.card} onSubmit={handleSubmit}>
        <h1 className={s.title}>Tremendous Care</h1>
        <p className={s.muted}>Sign in to see your shifts.</p>
        <label className={s.label} htmlFor="cg-email">Email</label>
        <input
          id="cg-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          className={s.input}
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        {error && <div className={s.error}>{error}</div>}
        <button type="submit" className={s.primaryBtn} disabled={submitting}>
          {submitting ? 'Sending…' : 'Email me a sign-in link'}
        </button>
        <p className={s.helper}>
          No password needed — we&rsquo;ll send you a one-time link.
        </p>
      </form>
    </div>
  );
}
