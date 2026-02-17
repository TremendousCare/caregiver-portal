import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';

const AppContext = createContext();

export function AppProvider({ children }) {
  const [toast, setToast] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);

  // ─── Toast auto-dismiss ───
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const showToast = useCallback((msg) => setToast(msg), []);

  // ─── Derived user info ───
  const currentUserName = currentUser?.displayName || '';
  const currentUserEmail = currentUser?.email || '';
  const isAdmin = currentUser?.isAdmin || false;

  // ─── Role lookup on login ───
  const handleUserReady = useCallback(async (userInfo) => {
    let userIsAdmin = false;
    if (userInfo.email && isSupabaseConfigured()) {
      try {
        const { data } = await supabase
          .from('user_roles')
          .select('role')
          .eq('email', userInfo.email.toLowerCase())
          .single();
        if (data) {
          userIsAdmin = data.role === 'admin';
        } else {
          await supabase.from('user_roles').insert({
            email: userInfo.email.toLowerCase(),
            role: 'member',
            updated_by: 'self-registration',
          });
        }
      } catch (err) {
        console.warn('Role lookup failed:', err.message);
      }
    }
    setCurrentUser({
      displayName: userInfo.displayName,
      email: userInfo.email,
      isAdmin: userIsAdmin,
    });
  }, []);

  // ─── Logout handler ───
  const handleLogout = useCallback(async () => {
    if (isSupabaseConfigured()) {
      await supabase.auth.signOut();
    } else {
      localStorage.removeItem('tc-auth-v1');
      localStorage.removeItem('tc-user-name-v1');
    }
    setCurrentUser(null);
    window.location.reload();
  }, []);

  return (
    <AppContext.Provider value={{
      toast, showToast,
      sidebarCollapsed, setSidebarCollapsed,
      currentUser, currentUserName, currentUserEmail, isAdmin,
      handleUserReady, handleLogout,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
