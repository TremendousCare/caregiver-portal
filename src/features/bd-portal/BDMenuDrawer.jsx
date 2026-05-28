import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Menu, X, LayoutDashboard, Users, KanbanSquare, UserPlus, ClipboardList,
  Home, Calendar, Activity, BarChart3, Target, Bot, Settings, Smartphone,
  LogOut,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { isAdminRole } from '../../lib/auth/roles';
import s from './BdPortal.module.css';

// Navigates the rep from the BD portal into the rest of the admin app.
// Items mirror the desktop sidebar (src/shared/layout/AppShell.jsx) but
// use lucide icons per the UI conventions in CLAUDE.md and rely on a
// lightweight user_roles check rather than AppContext (which is only
// hydrated inside the admin shell, not the BD surface).
function useAdminRole() {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const email = session?.user?.email;
        if (!email) return;
        const { data } = await supabase
          .from('user_roles')
          .select('role')
          .eq('email', email.toLowerCase())
          .maybeSingle();
        if (cancelled) return;
        setIsAdmin(isAdminRole(data?.role));
      } catch {
        /* non-fatal — admin items just stay hidden */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return isAdmin;
}

function buildSections(isAdmin) {
  return [
    {
      id: 'caregivers',
      label: 'Caregivers',
      items: [
        { path: '/',              label: 'Dashboard',       icon: LayoutDashboard },
        ...(isAdmin ? [
          { path: '/pipeline-health', label: 'Pipeline Health', icon: Activity },
        ] : []),
        { path: '/board',         label: 'Caregiver Board', icon: KanbanSquare },
        { path: '/roster',        label: 'Active Roster',   icon: Users },
        { path: '/add',           label: 'New Caregiver',   icon: UserPlus },
      ],
    },
    {
      id: 'clients',
      label: 'Clients',
      items: [
        { path: '/clients/active',    label: 'Active Clients', icon: Home },
        { path: '/clients',           label: 'Clients',        icon: Users },
        { path: '/clients/add',       label: 'New Client',     icon: UserPlus },
        { path: '/clients/sequences', label: 'Sequences',      icon: ClipboardList },
      ],
    },
    {
      id: 'scheduling',
      label: 'Scheduling',
      items: [
        { path: '/schedule', label: 'Calendar', icon: Calendar },
      ],
    },
    {
      id: 'boards',
      label: 'Boards',
      items: [
        { path: '/boards', label: 'All Boards', icon: ClipboardList },
      ],
    },
    {
      id: 'bd',
      label: 'Business Development',
      items: [
        { path: '/bd', label: 'BD Portal', icon: Smartphone },
        ...(isAdmin ? [
          { path: '/bd-funnel', label: 'Funnel Report', icon: BarChart3 },
          { path: '/bd-goals',  label: 'Goals',         icon: Target },
        ] : []),
      ],
    },
    ...(isAdmin ? [{
      id: 'ai-agents',
      label: 'AI Agents',
      items: [
        { path: '/agent-metrics', label: 'Agent Metrics',      icon: Bot },
        { path: '/agent-grading', label: 'Suggestion Grading', icon: Bot },
      ],
    }] : []),
    ...(isAdmin ? [{
      id: 'settings',
      label: 'Settings',
      items: [
        { path: '/settings', label: 'Admin Settings', icon: Settings },
      ],
    }] : []),
  ];
}

// Mirrors BottomNav.jsx: modal flows (log, refer, plan, contact edit,
// mileage entry) and the account-detail view have their own back/cancel
// buttons at the top-left, so the hamburger would visually collide with
// them. Top-level destinations (Today, Accounts list, Mileage list) get
// the hamburger.
function shouldShowMenu(pathname) {
  const p = pathname;
  if (
    p === '/bd/log'    || p.endsWith('/log')
    || p === '/bd/refer' || p.endsWith('/refer')
    || p === '/bd/plan'
    || p.endsWith('/contact')
    || p.endsWith('/contact/new')
    || /\/contact\/[^/]+\/edit$/.test(p)
    || p === '/bd/mileage/new'
    || /^\/bd\/mileage\/[^/]+$/.test(p)
    || /^\/bd\/accounts\/[^/]+$/.test(p)
  ) {
    return false;
  }
  return true;
}

export function BDMenuDrawer({ onSignOut }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = useAdminRole();
  const [open, setOpen] = useState(false);
  const sections = buildSections(isAdmin);
  const showMenu = shouldShowMenu(location.pathname);

  // Close drawer whenever route changes (defensive — handleGo also closes).
  useEffect(() => { setOpen(false); }, [location.pathname]);

  // Lock body scroll while drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function handleGo(path) {
    setOpen(false);
    navigate(path);
  }

  if (!showMenu) return null;

  return (
    <>
      <button
        type="button"
        className={s.menuBtn}
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
      >
        <Menu size={20} strokeWidth={2} />
      </button>

      {open && (
        <div
          className={s.menuOverlay}
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={`${s.menuDrawer} ${open ? s.menuDrawerOpen : ''}`}
        aria-label="Navigation"
        aria-hidden={!open}
      >
        <div className={s.menuDrawerHeader}>
          <div className={s.menuDrawerTitle}>Navigate</div>
          <button
            type="button"
            className={s.menuCloseBtn}
            onClick={() => setOpen(false)}
            aria-label="Close navigation menu"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <div className={s.menuDrawerBody}>
          {sections.map((section) => (
            <div key={section.id} className={s.menuSection}>
              <div className={s.menuSectionLabel}>{section.label}</div>
              {section.items.map((item) => {
                const Icon = item.icon;
                const isCurrent =
                  item.path === '/bd' &&
                  (location.pathname === '/bd' || location.pathname.startsWith('/bd/'));
                return (
                  <button
                    key={item.path}
                    type="button"
                    className={`${s.menuItem} ${isCurrent ? s.menuItemActive : ''}`}
                    onClick={() => handleGo(item.path)}
                  >
                    <span className={s.menuItemIcon} aria-hidden>
                      <Icon size={18} strokeWidth={1.75} />
                    </span>
                    <span className={s.menuItemLabel}>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {onSignOut && (
          <div className={s.menuDrawerFooter}>
            <button
              type="button"
              className={s.menuSignOutItem}
              onClick={() => { setOpen(false); onSignOut(); }}
            >
              <span className={s.menuItemIcon} aria-hidden>
                <LogOut size={18} strokeWidth={1.75} />
              </span>
              <span className={s.menuItemLabel}>Sign out</span>
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
