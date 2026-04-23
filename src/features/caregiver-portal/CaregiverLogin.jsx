import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import s from './CaregiverPortal.module.css';

// Caregiver sign-in.
//
// Default: email + password. New caregivers are provisioned with a
// password by an admin (see caregiver-invite edge function,
// action: "create_password") and told their credentials out-of-band.
//
// Magic-link fallback: kept for caregivers onboarded before the
// password flow existed, and as a "forgot password" escape hatch.
// The admin-initiated reset via resetPasswordForEmail is also
// available by clicking "Forgot password?".

export function CaregiverLogin() {
  const [mode, setMode] = useState('password'); // 'password' | 'magic' | 'reset'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  const normalizedEmail = email.trim().toLowerCase();

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!normalizedEmail) {
      setError('Please enter your email.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }
    setSubmitting(true);
    try {
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });
      if (signInErr) {
        if (/invalid login credentials/i.test(signInErr.message)) {
          throw new Error('Email or password is incorrect. If you signed up before we had passwords, use "Email me a sign-in link" below.');
        }
        throw signInErr;
      }
      // Auth state change will flip the PWA into the signed-in view.
    } catch (err) {
      setError(err?.message || 'Could not sign in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleMagicSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!normalizedEmail) {
      setError('Please enter your email.');
      return;
    }
    setSubmitting(true);
    try {
      const { error: signInErr } = await supabase.auth.signInWithOtp({
        email: normalizedEmail,
        options: {
          emailRedirectTo: `${window.location.origin}/care`,
        },
      });
      if (signInErr) throw signInErr;
      setInfo(`We sent a sign-in link to ${normalizedEmail}. Tap the link on your phone to open the app.`);
    } catch (err) {
      setError(err?.message || 'Could not send the link. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!normalizedEmail) {
      setError('Please enter your email.');
      return;
    }
    setSubmitting(true);
    try {
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: `${window.location.origin}/care`,
      });
      if (resetErr) throw resetErr;
      setInfo(`If an account exists for ${normalizedEmail}, we sent a password reset link. Check your email.`);
    } catch (err) {
      setError(err?.message || 'Could not send the reset email. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (mode === 'magic') {
    return (
      <div className={s.centered}>
        <form className={s.card} onSubmit={handleMagicSubmit}>
          <h1 className={s.title}>Sign in with email link</h1>
          <p className={s.muted}>
            We&rsquo;ll email you a one-time sign-in link. Use this if you don&rsquo;t
            have a password yet.
          </p>
          <label className={s.label} htmlFor="cg-email-magic">Email</label>
          <input
            id="cg-email-magic"
            type="email"
            inputMode="email"
            autoComplete="email"
            className={s.input}
            placeholder="you@example.com"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            required
          />
          {error && <div className={s.error}>{error}</div>}
          {info && <div className={s.successBanner}>{info}</div>}
          <button type="submit" className={s.primaryBtn} disabled={submitting}>
            {submitting ? 'Sending…' : 'Email me a sign-in link'}
          </button>
          <button
            type="button"
            className={s.linkBtn}
            onClick={() => { setMode('password'); setError(''); setInfo(''); }}
          >
            Back to password sign-in
          </button>
        </form>
      </div>
    );
  }

  if (mode === 'reset') {
    return (
      <div className={s.centered}>
        <form className={s.card} onSubmit={handleResetSubmit}>
          <h1 className={s.title}>Reset your password</h1>
          <p className={s.muted}>
            Enter your email and we&rsquo;ll send you a link to set a new password.
          </p>
          <label className={s.label} htmlFor="cg-email-reset">Email</label>
          <input
            id="cg-email-reset"
            type="email"
            inputMode="email"
            autoComplete="email"
            className={s.input}
            placeholder="you@example.com"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            required
          />
          {error && <div className={s.error}>{error}</div>}
          {info && <div className={s.successBanner}>{info}</div>}
          <button type="submit" className={s.primaryBtn} disabled={submitting}>
            {submitting ? 'Sending…' : 'Send reset link'}
          </button>
          <button
            type="button"
            className={s.linkBtn}
            onClick={() => { setMode('password'); setError(''); setInfo(''); }}
          >
            Back to sign-in
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={s.centered}>
      <form className={s.card} onSubmit={handlePasswordSubmit}>
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
        <label className={s.label} htmlFor="cg-password">Password</label>
        <input
          id="cg-password"
          type="password"
          autoComplete="current-password"
          className={s.input}
          placeholder="Your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <div className={s.error}>{error}</div>}
        {info && <div className={s.successBanner}>{info}</div>}
        <button type="submit" className={s.primaryBtn} disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        <button
          type="button"
          className={s.linkBtn}
          onClick={() => { setMode('reset'); setError(''); setInfo(''); }}
        >
          Forgot password?
        </button>
        <button
          type="button"
          className={s.linkBtn}
          onClick={() => { setMode('magic'); setError(''); setInfo(''); }}
        >
          Email me a sign-in link instead
        </button>
      </form>
    </div>
  );
}
