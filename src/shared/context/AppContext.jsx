import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase, isSupabaseConfigured, getOrgClaims } from '../../lib/supabase';
import { loadActionItemRules } from '../../lib/actionItemEngine';

const AppContext = createContext();

export function AppProvider({ children }) {
  const [toast, setToast] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  // Org claims from JWT — populated on login, cleared on logout.
  // Phase A: stored only. No other code reads these yet.
  const [currentOrgId, setCurrentOrgId] = useState(null);
  const [currentOrgSlug, setCurrentOrgSlug] = useState(null);
  const [currentOrgRole, setCurrentOrgRole] = useState(null);
  // Per-org settings jsonb. Phase 4 PR #1 introduces this so the
  // sidebar can gate Accounting on features_enabled.payroll, and the
  // payroll UI can read pay_components / mileage_rate without going
  // back to the DB on every render. Loaded once at login alongside
  // the role lookup. Refreshable via refreshOrgSettings() after
  // Settings UI edits ship in PR #3.
  const [currentOrgSettings, setCurrentOrgSettings] = useState(null);

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
  const currentUserMailbox = currentUser?.mailboxEmail || currentUser?.email || '';
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
    let mailboxEmail = userInfo.email || '';
    if (userInfo.email && isSupabaseConfigured()) {
      try {
        // Pull org claims from the current session JWT. Phase A: the
        // claims are stored on context but not consumed anywhere else
        // yet. getOrgClaims returns nulls on any failure.
        const { data: sessionData } = await supabase.auth.getSession();
        const claims = getOrgClaims(sessionData?.session);
        setCurrentOrgId(claims.orgId);
        setCurrentOrgSlug(claims.orgSlug);
        setCurrentOrgRole(claims.orgRole);

        // Load org settings (jsonb) once. Failure here is non-fatal —
        // the rest of the app works without it; payroll UI just
        // doesn't render until a refresh.
        if (claims.orgId) {
          const { data: orgRow } = await supabase
            .from('organizations')
            .select('settings')
            .eq('id', claims.orgId)
            .maybeSingle();
          setCurrentOrgSettings((orgRow && orgRow.settings) || {});
        }

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
          .select('role, mailbox_email')
          .eq('email', userInfo.email.toLowerCase())
          .maybeSingle();
        if (data) {
          userIsAdmin = data.role === 'admin';
          mailboxEmail = data.mailbox_email || userInfo.email;
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
      mailboxEmail,
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
    setCurrentOrgId(null);
    setCurrentOrgSlug(null);
    setCurrentOrgRole(null);
    setCurrentOrgSettings(null);
    window.location.reload();
  }, []);

  // Reload org settings — used after Settings UI writes (Phase 4 PR #3)
  // to keep the in-memory copy in sync without forcing a logout.
  const refreshOrgSettings = useCallback(async () => {
    if (!currentOrgId || !isSupabaseConfigured()) return;
    const { data: orgRow } = await supabase
      .from('organizations')
      .select('settings')
      .eq('id', currentOrgId)
      .maybeSingle();
    setCurrentOrgSettings((orgRow && orgRow.settings) || {});
  }, [currentOrgId]);

  return (
    <AppContext.Provider value={{
      toast, showToast,
      sidebarCollapsed, setSidebarCollapsed,
      mobileMenuOpen, setMobileMenuOpen,
      currentUser, currentUserName, currentUserEmail, currentUserMailbox, isAdmin,
      currentOrgId, currentOrgSlug, currentOrgRole,
      currentOrgSettings, refreshOrgSettings,
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
