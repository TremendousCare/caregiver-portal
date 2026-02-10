import { useState, useEffect } from 'react';
import { loadAuthState, saveAuthState } from '../lib/storage';
import { authStyles } from '../styles/theme';

const TEAM_PASSWORD = 'TremendousCare2025';
const USER_NAME_KEY = 'tc-user-name-v1';

export function AuthGate({ children, onUserReady }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(true);
  const [userName, setUserName] = useState('');
  const [needsName, setNeedsName] = useState(false);

  useEffect(() => {
    loadAuthState().then((isAuth) => {
      if (isAuth) {
        const stored = localStorage.getItem(USER_NAME_KEY);
        if (stored) {
          setAuthenticated(true);
          onUserReady(stored);
        } else {
          setAuthenticated(true);
          setNeedsName(true);
        }
      }
      setChecking(false);
    });
  }, []);

  const handleLogin = async () => {
    if (password === TEAM_PASSWORD) {
      setError(false);
      await saveAuthState();
      const stored = localStorage.getItem(USER_NAME_KEY);
      if (stored) {
        setAuthenticated(true);
        onUserReady(stored);
      } else {
        setAuthenticated(true);
        setNeedsName(true);
      }
    } else {
      setError(true);
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
