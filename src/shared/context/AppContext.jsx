import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { loadActionItemRules } from '../../lib/actionItemEngine';

const AppContext = createContext();

export function AppProvider({ children }) {
  const [toast, setToast] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);

  // ─── Load action item rules cache on mount ───
  useEffect(() => {
    loadActionItemRules();
  }, []);

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
  // If the authenticated user is linked to a caregiver record, they're
  // a caregiver — redirect to /care and skip the staff role lookup.
  // Otherwise do the staff role lookup. We no longer auto-insert as
  // 'member' on first login; new staff must be added by an admin via
  // Settings → Team. This closes the "caregiver auto-promotes to
  // staff" path exposed by the caregiver PWA.
  const handleUserReady = useCallback(async (userInfo) => {
    let userIsAdmin = false;
    let noRole = false;
    if (userInfo.email && isSupabaseConfigured()) {
      try {
        // Is this a caregiver account? (Only visible if linked via user_id
        // and the RLS policy caregivers_read_own matches auth.uid().)
        const { data: authData } = await supabase.auth.getUser();
        const uid = authData?.user?.id;
        if (uid) {
          const { data: cgRow } = await supabase
            .from('caregivers')
            .select('id')
            .eq('user_id', uid)
            .maybeSingle();
          if (cgRow && typeof window !== 'undefined' && !window.location.pathname.startsWith('/care')) {
            window.location.replace('/care');
            return;
          }
        }

        const { data } = await supabase
          .from('user_roles')
          .select('role')
          .eq('email', userInfo.email.toLowerCase())
          .maybeSingle();
        if (data) {
          userIsAdmin = data.role === 'admin';
        } else {
          noRole = true;
        }
      } catch (err) {
        console.warn('Role lookup failed:', err.message);
      }
    }
    setCurrentUser({
      displayName: userInfo.displayName,
      email: userInfo.email,
      isAdmin: userIsAdmin,
      noRole,
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
      mobileMenuOpen, setMobileMenuOpen,
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
