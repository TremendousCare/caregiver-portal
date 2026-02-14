import { useState, useEffect } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import s from './AuthGate.module.css';

// ─── Fallback: localStorage-based auth (when Supabase not configured) ───
const LEGACY_PASSWORD = 'TremendousCare2025';
const USER_NAME_KEY = 'tc-user-name-v1';
const AUTH_KEY = 'tc-auth-v1';

export function AuthGate({ children, onUserReady, onLogout }) {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [signUpSuccess, setSignUpSuccess] = useState(false);
  const [isResetPassword, setIsResetPassword] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [isSettingPassword, setIsSettingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // ─── Legacy fallback state (no Supabase) ───
  const [legacyMode] = useState(!isSupabaseConfigured());
  const [legacyPassword, setLegacyPassword] = useState('');
  const [legacyAuth, setLegacyAuth] = useState(false);
  const [legacyError, setLegacyError] = useState(false);
  const [needsName, setNeedsName] = useState(false);
  const [userName, setUserName] = useState('');

  useEffect(() => {
    if (legacyMode) {
      // Legacy: check localStorage
      const val = localStorage.getItem(AUTH_KEY);
      if (val === '"authenticated"' || val === 'authenticated') {
        const stored = localStorage.getItem(USER_NAME_KEY);
        if (stored) {
          setLegacyAuth(true);
          onUserReady({ displayName: stored, email: null });
        } else {
          setLegacyAuth(true);
          setNeedsName(true);
        }
      }
      setChecking(false);
      return;
    }

    // Supabase Auth: check existing session
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      if (s?.user) {
        const displayName = s.user.user_metadata?.full_name || s.user.email?.split('@')[0] || 'User';
        onUserReady({ displayName, email: s.user.email });
      }
      setChecking(false);
    });

    // Listen for auth state changes (login, logout, password recovery, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (_event === 'PASSWORD_RECOVERY') {
        // User clicked the reset link — show password form instead of entering the app
        setIsSettingPassword(true);
        return;
      }
      if (s?.user && !isSettingPassword) {
        const displayName = s.user.user_metadata?.full_name || s.user.email?.split('@')[0] || 'User';
        onUserReady({ displayName, email: s.user.email });
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ─── Supabase: Sign in with email + password ───
  const handleSignIn = async () => {
    if (!email.trim() || !password) return;
    setSubmitting(true);
    setError('');

    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    setSubmitting(false);
    if (authError) {
      setError(authError.message);
    }
    // On success, onAuthStateChange fires automatically
  };

  // ─── Supabase: Sign up with email + password ───
  const handleSignUp = async () => {
    if (!email.trim() || !password || !fullName.trim()) return;
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setSubmitting(true);
    setError('');

    const { error: authError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { full_name: fullName.trim() },
      },
    });

    setSubmitting(false);
    if (authError) {
      setError(authError.message);
    } else {
      setSignUpSuccess(true);
    }
  };

  const handleSubmit = () => {
    if (isSignUp) handleSignUp();
    else handleSignIn();
  };

  // ─── Supabase: Reset password ───
  const handleResetPassword = async () => {
    if (!email.trim()) {
      setError('Please enter your email address first.');
      return;
    }
    setSubmitting(true);
    setError('');

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    });

    setSubmitting(false);
    if (resetError) {
      setError(resetError.message);
    } else {
      setResetSent(true);
    }
  };

  // ─── Supabase: Set new password (after clicking reset link) ───
  const handleSetPassword = async () => {
    if (!newPassword || newPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    setError('');

    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    setSubmitting(false);
    if (updateError) {
      setError(updateError.message);
    } else {
      // Password set successfully — proceed to app
      setIsSettingPassword(false);
      setNewPassword('');
      setConfirmPassword('');
      // The session is already active, so trigger onUserReady
      const { data: { session: s } } = await supabase.auth.getSession();
      if (s?.user) {
        const displayName = s.user.user_metadata?.full_name || s.user.email?.split('@')[0] || 'User';
        onUserReady({ displayName, email: s.user.email });
      }
    }
  };

  // ─── Legacy: passcode login ───
  const handleLegacyLogin = () => {
    if (legacyPassword === LEGACY_PASSWORD) {
      setLegacyError(false);
      localStorage.setItem(AUTH_KEY, JSON.stringify('authenticated'));
      const stored = localStorage.getItem(USER_NAME_KEY);
      if (stored) {
        setLegacyAuth(true);
        onUserReady({ displayName: stored, email: null });
      } else {
        setLegacyAuth(true);
        setNeedsName(true);
      }
    } else {
      setLegacyError(true);
    }
  };

  const handleNameSubmit = () => {
    if (!userName.trim()) return;
    const name = userName.trim();
    localStorage.setItem(USER_NAME_KEY, name);
    setNeedsName(false);
    onUserReady({ displayName: name, email: null });
  };

  if (checking) return null;

  // ─── Legacy mode (no Supabase) ───
  if (legacyMode) {
    if (!legacyAuth) {
      return (
        <div className={s.wrapper}>
          <div className={s.card}>
            <div className={s.logoIcon}>TC</div>
            <h1 className={s.title}>Tremendous Care</h1>
            <p className={s.subtitle}>Caregiver Portal</p>
            <div className={s.divider} />
            <p className={s.prompt}>Enter your team access code to continue</p>
            <input
              className={s.input}
              style={legacyError ? { borderColor: '#DC3545' } : {}}
              type="password"
              placeholder="Team access code"
              value={legacyPassword}
              onChange={(e) => { setLegacyPassword(e.target.value); setLegacyError(false); }}
              onKeyDown={(e) => e.key === 'Enter' && handleLegacyLogin()}
              autoFocus
            />
            {legacyError && <p className={s.error}>Incorrect access code. Please try again.</p>}
            <button className={s.button} onClick={handleLegacyLogin}>Sign In</button>
            <p className={s.footer}>Contact your administrator if you need access.</p>
          </div>
        </div>
      );
    }
    if (needsName) {
      return (
        <div className={s.wrapper}>
          <div className={s.card}>
            <div className={s.logoIcon}>TC</div>
            <h1 className={s.title}>Welcome!</h1>
            <p className={s.subtitle}>Caregiver Portal</p>
            <div className={s.divider} />
            <p className={s.prompt}>Enter your name so we can track your activity</p>
            <input
              className={s.input}
              type="text"
              placeholder="Your name (e.g., Sarah, Mike)"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()}
              autoFocus
            />
            <button className={s.button} style={{ opacity: userName.trim() ? 1 : 0.5 }} onClick={handleNameSubmit} disabled={!userName.trim()}>
              Continue
            </button>
          </div>
        </div>
      );
    }
    return children;
  }

  // ─── Supabase Auth: not logged in ───
  if (!session) {
    // Password reset sent confirmation
    if (resetSent) {
      return (
        <div className={s.wrapper}>
          <div className={s.card}>
            <div className={s.logoIcon}>TC</div>
            <h1 className={s.title}>Check Your Email</h1>
            <p className={s.subtitle}>Caregiver Portal</p>
            <div className={s.divider} />
            <p className={s.prompt} style={{ fontSize: 15, lineHeight: 1.6 }}>
              We sent a password reset link to <strong>{email}</strong>
            </p>
            <p className={s.prompt} style={{ color: '#8BA3C7', fontSize: 13 }}>
              Click the link in the email to set your password, then come back and sign in.
            </p>
            <button
              className={s.button}
              onClick={() => {
                setResetSent(false);
                setIsResetPassword(false);
                setPassword('');
                setError('');
              }}
            >
              Back to Sign In
            </button>
          </div>
        </div>
      );
    }

    // Password reset form
    if (isResetPassword) {
      return (
        <div className={s.wrapper}>
          <div className={s.card}>
            <div className={s.logoIcon}>TC</div>
            <h1 className={s.title}>Reset Password</h1>
            <p className={s.subtitle}>Caregiver Portal</p>
            <div className={s.divider} />
            <p className={s.prompt}>
              Enter your email and we'll send you a link to set your password.
            </p>

            <input
              className={s.input}
              style={{ ...(error ? { borderColor: '#DC3545' } : {}), letterSpacing: 0, textAlign: 'left' }}
              type="email"
              placeholder="you@tremendouscare.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && handleResetPassword()}
              autoFocus
            />

            {error && <p className={s.error}>{error}</p>}

            <button
              className={s.button}
              style={{ opacity: submitting || !email.trim() ? 0.5 : 1 }}
              onClick={handleResetPassword}
              disabled={submitting || !email.trim()}
            >
              {submitting ? 'Sending...' : 'Send Reset Link'}
            </button>

            <button
              className={s.button}
              style={{
                background: 'transparent',
                color: '#2E4E8D',
                border: '2px solid #E0E4EA',
                marginTop: 8,
              }}
              onClick={() => {
                setIsResetPassword(false);
                setError('');
              }}
            >
              Back to Sign In
            </button>
          </div>
        </div>
      );
    }

    // Sign-up success: prompt to check email for confirmation
    if (signUpSuccess) {
      return (
        <div className={s.wrapper}>
          <div className={s.card}>
            <div className={s.logoIcon}>TC</div>
            <h1 className={s.title}>Account Created!</h1>
            <p className={s.subtitle}>Caregiver Portal</p>
            <div className={s.divider} />
            <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
            <p className={s.prompt} style={{ fontSize: 15, lineHeight: 1.6 }}>
              Your account has been created for <strong>{email}</strong>
            </p>
            <p className={s.prompt} style={{ color: '#8BA3C7', fontSize: 13 }}>
              Check your email to confirm your account, then sign in below.
            </p>
            <button
              className={s.button}
              onClick={() => {
                setSignUpSuccess(false);
                setIsSignUp(false);
                setPassword('');
                setFullName('');
              }}
            >
              Go to Sign In
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className={s.wrapper}>
        <div className={s.card}>
          <div className={s.logoIcon}>TC</div>
          <h1 className={s.title}>Tremendous Care</h1>
          <p className={s.subtitle}>Caregiver Portal</p>
          <div className={s.divider} />
          <p className={s.prompt}>
            {isSignUp ? 'Create your account' : 'Sign in to your account'}
          </p>

          {/* Full name (sign-up only) */}
          {isSignUp && (
            <input
              className={s.input}
              style={{ letterSpacing: 0, textAlign: 'left' }}
              type="text"
              placeholder="Your full name"
              value={fullName}
              onChange={(e) => { setFullName(e.target.value); setError(''); }}
              autoFocus
            />
          )}

          {/* Email */}
          <input
            className={s.input}
            style={{ ...(error ? { borderColor: '#DC3545' } : {}), letterSpacing: 0, textAlign: 'left' }}
            type="email"
            placeholder="you@tremendouscare.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            autoFocus={!isSignUp}
          />

          {/* Password */}
          <input
            className={s.input}
            style={{ ...(error ? { borderColor: '#DC3545' } : {}), letterSpacing: 0, textAlign: 'left' }}
            type="password"
            placeholder={isSignUp ? 'Create a password (min 6 chars)' : 'Password'}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />

          {error && <p className={s.error}>{error}</p>}

          {/* Forgot password link (sign-in only) */}
          {!isSignUp && (
            <button
              style={{
                background: 'none', border: 'none', color: '#2E4E8D',
                fontSize: 13, cursor: 'pointer', padding: '4px 0',
                marginBottom: 4, fontFamily: 'inherit', textDecoration: 'underline',
                opacity: 0.8,
              }}
              onClick={() => { setIsResetPassword(true); setError(''); setPassword(''); }}
            >
              Forgot password? Set up your password here
            </button>
          )}

          <button
            className={s.button}
            style={{ opacity: submitting || !email.trim() || !password ? 0.5 : 1 }}
            onClick={handleSubmit}
            disabled={submitting || !email.trim() || !password}
          >
            {submitting ? (isSignUp ? 'Creating Account...' : 'Signing In...') : (isSignUp ? 'Create Account' : 'Sign In')}
          </button>

          {/* Toggle sign-in / sign-up */}
          <button
            className={s.button}
            style={{
              background: 'transparent',
              color: '#2E4E8D',
              border: '2px solid #E0E4EA',
              marginTop: 8,
            }}
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError('');
              setPassword('');
              setFullName('');
            }}
          >
            {isSignUp ? 'Already have an account? Sign In' : 'Need an account? Sign Up'}
          </button>

          <p className={s.footer}>
            {isSignUp
              ? 'Your administrator will need to approve your account.'
              : 'Contact your administrator if you need access.'}
          </p>
        </div>
      </div>
    );
  }

  // ─── Set New Password (after clicking reset link) ───
  if (isSettingPassword) {
    return (
      <div className={s.wrapper}>
        <div className={s.card}>
          <div className={s.logoIcon}>TC</div>
          <h1 className={s.title}>Set Your Password</h1>
          <p className={s.subtitle}>Caregiver Portal</p>
          <div className={s.divider} />
          <p className={s.prompt}>
            {session?.user?.email ? `Setting password for ${session.user.email}` : 'Create a password for your account.'}
          </p>

          <input
            className={s.input}
            style={{ ...(error ? { borderColor: '#DC3545' } : {}), letterSpacing: 0, textAlign: 'left' }}
            type="password"
            placeholder="New password (min 6 characters)"
            value={newPassword}
            onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && confirmPassword && handleSetPassword()}
            autoFocus
          />

          <input
            className={s.input}
            style={{ ...(error ? { borderColor: '#DC3545' } : {}), letterSpacing: 0, textAlign: 'left' }}
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && handleSetPassword()}
          />

          {error && <p className={s.error}>{error}</p>}

          <button
            className={s.button}
            style={{ opacity: submitting || !newPassword || !confirmPassword ? 0.5 : 1 }}
            onClick={handleSetPassword}
            disabled={submitting || !newPassword || !confirmPassword}
          >
            {submitting ? 'Setting Password...' : 'Set Password & Continue'}
          </button>
        </div>
      </div>
    );
  }

  // ─── Authenticated ───
  return children;
}
