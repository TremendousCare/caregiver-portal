import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import s from './BdPortal.module.css';

// Owner reuses her existing Tremendous Care portal credentials.
// No sign-up flow inside /bd; if she needs an account she goes
// through the admin portal.
export function BDLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSignIn() {
    if (!email.trim() || !password) return;
    setSubmitting(true);
    setError('');
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (authError) setError(authError.message);
    // Success → onAuthStateChange in useBdSession picks it up.
  }

  return (
    <div className={s.centered}>
      <div className={s.loginCard}>
        <div className={s.loginLogo}>BD</div>
        <h1 className={s.loginTitle}>Business Development</h1>
        <p className={s.loginSubtitle}>Tremendous Care</p>

        <input
          className={s.input}
          type="email"
          placeholder="Email"
          autoComplete="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && handleSignIn()}
          autoFocus
        />
        <input
          className={s.input}
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && handleSignIn()}
        />

        {error && <p className={s.error}>{error}</p>}

        <button
          type="button"
          className={s.button}
          onClick={handleSignIn}
          disabled={submitting || !email.trim() || !password}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}
