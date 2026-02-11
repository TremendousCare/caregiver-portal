import { useState, useEffect } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { authStyles } from '../styles/theme';

// ─── Fallback: localStorage-based auth (when Supabase not configured) ───
const LEGACY_PASSWORD = 'TremendousCare2025';
const USER_NAME_KEY = 'tc-user-name-v1';
const AUTH_KEY = 'tc-auth-v1';

export function AuthGate({ children, onUserReady, onLogout }) {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [sending, setSending] = useState(false);

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
          onUserReady(stored);
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
        onUserReady(displayName);
      }
      setChecking(false);
    });

    // Listen for auth state changes (magic link callback, logout, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s?.user) {
        const displayName = s.user.user_metadata?.full_name || s.user.email?.split('@')[0] || 'User';
        onUserReady(displayName);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ─── Supabase: Send magic link ───
  const handleMagicLink = async () => {
    if (!email.trim()) return;
    setSending(true);
    setError('');

    const { error: authError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    setSending(false);
    if (authError) {
      setError(authError.message);
    } else {
      setMagicLinkSent(true);
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
        onUserReady(stored);
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
    onUserReady(name);
  };

  if (checking) return null;

  // ─── Legacy mode (no Supabase) ───
  if (legacyMode) {
    if (!legacyAuth) {
      return (
        <div style={authStyles.wrapper}>
          <div style={authStyles.card}>
            <div style={authStyles.logoIcon}>TC</div>
            <h1 style={authStyles.title}>Tremendous Care</h1>
            <p style={authStyles.subtitle}>Caregiver Portal</p>
            <div style={authStyles.divider} />
            <p style={authStyles.prompt}>Enter your team access code to continue</p>
            <input
              style={{ ...authStyles.input, ...(legacyError ? { borderColor: '#DC3545' } : {}) }}
              type="password"
              placeholder="Team access code"
              value={legacyPassword}
              onChange={(e) => { setLegacyPassword(e.target.value); setLegacyError(false); }}
              onKeyDown={(e) => e.key === 'Enter' && handleLegacyLogin()}
              autoFocus
            />
            {legacyError && <p style={authStyles.error}>Incorrect access code. Please try again.</p>}
            <button style={authStyles.button} onClick={handleLegacyLogin}>Sign In</button>
            <p style={authStyles.footer}>Contact your administrator if you need access.</p>
          </div>
        </div>
      );
    }
    if (needsName) {
      return (
        <div style={authStyles.wrapper}>
          <div style={authStyles.card}>
            <div style={authStyles.logoIcon}>TC</div>
            <h1 style={authStyles.title}>Welcome!</h1>
            <p style={authStyles.subtitle}>Caregiver Portal</p>
            <div style={authStyles.divider} />
            <p style={authStyles.prompt}>Enter your name so we can track your activity</p>
            <input
              style={authStyles.input}
              type="text"
              placeholder="Your name (e.g., Sarah, Mike)"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()}
              autoFocus
            />
            <button style={{ ...authStyles.button, opacity: userName.trim() ? 1 : 0.5 }} onClick={handleNameSubmit} disabled={!userName.trim()}>
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
    if (magicLinkSent) {
      return (
        <div style={authStyles.wrapper}>
          <div style={authStyles.card}>
            <div style={authStyles.logoIcon}>TC</div>
            <h1 style={authStyles.title}>Check Your Email</h1>
            <p style={authStyles.subtitle}>Caregiver Portal</p>
            <div style={authStyles.divider} />
            <div style={{ fontSize: 48, marginBottom: 16 }}>📧</div>
            <p style={{ ...authStyles.prompt, fontSize: 15, lineHeight: 1.6 }}>
              We sent a login link to <strong>{email}</strong>
            </p>
            <p style={{ ...authStyles.prompt, color: '#8BA3C7', fontSize: 13 }}>
              Click the link in your email to sign in. The link expires in 1 hour.
            </p>
            <button
              style={{ ...authStyles.button, background: 'transparent', color: '#2E4E8D', border: '2px solid #E0E4EA', marginTop: 8 }}
              onClick={() => { setMagicLinkSent(false); setEmail(''); }}
            >
              Use a different email
            </button>
          </div>
        </div>
      );
    }

    return (
      <div style={authStyles.wrapper}>
        <div style={authStyles.card}>
          <div style={authStyles.logoIcon}>TC</div>
          <h1 style={authStyles.title}>Tremendous Care</h1>
          <p style={authStyles.subtitle}>Caregiver Portal</p>
          <div style={authStyles.divider} />
          <p style={authStyles.prompt}>Enter your email to receive a login link</p>
          <input
            style={{ ...authStyles.input, ...(error ? { borderColor: '#DC3545' } : {}), letterSpacing: 0, textAlign: 'left' }}
            type="email"
            placeholder="you@tremendouscare.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && handleMagicLink()}
            autoFocus
          />
          {error && <p style={authStyles.error}>{error}</p>}
          <button
            style={{ ...authStyles.button, opacity: sending || !email.trim() ? 0.5 : 1 }}
            onClick={handleMagicLink}
            disabled={sending || !email.trim()}
          >
            {sending ? 'Sending...' : 'Send Login Link'}
          </button>
          <p style={authStyles.footer}>You'll receive a magic link — no password needed.</p>
        </div>
      </div>
    );
  }

  // ─── Authenticated ───
  return children;
}
