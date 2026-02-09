import { useState, useEffect } from 'react';
import { loadAuthState, saveAuthState } from '../lib/storage';
import { authStyles } from '../styles/theme';

const TEAM_PASSWORD = 'TremendousCare2025';

export function AuthGate({ children }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    loadAuthState().then((isAuth) => {
      if (isAuth) setAuthenticated(true);
      setChecking(false);
    });
  }, []);

  const handleLogin = async () => {
    if (password === TEAM_PASSWORD) {
      setAuthenticated(true);
      setError(false);
      await saveAuthState();
    } else {
      setError(true);
    }
  };

  if (checking) return null;

  if (!authenticated) {
    return (
      <div style={authStyles.wrapper}>
        <div style={authStyles.card}>
          <div style={authStyles.logoIcon}>TC</div>
          <h1 style={authStyles.title}>Tremendous Care</h1>
          <p style={authStyles.subtitle}>Caregiver Portal</p>
          <div style={authStyles.divider} />
          <p style={authStyles.prompt}>Enter your team access code to continue</p>
          <input
            style={{
              ...authStyles.input,
              ...(error ? { borderColor: '#DC3545' } : {}),
            }}
            type="password"
            placeholder="Team access code"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(false); }}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            autoFocus
          />
          {error && <p style={authStyles.error}>Incorrect access code. Please try again.</p>}
          <button style={authStyles.button} onClick={handleLogin}>
            Sign In
          </button>
          <p style={authStyles.footer}>Contact your administrator if you need access.</p>
        </div>
      </div>
    );
  }

  return children;
}
