import { NavLink, useLocation } from 'react-router-dom';
import { Sun, Building2 } from 'lucide-react';
import s from './BdPortal.module.css';

export function BottomNav() {
  const location = useLocation();
  // The capture, referral, contact-edit, and route-builder screens
  // are "modal" — we don't show the bottom nav there so the form
  // gets the full screen.
  const p = location.pathname;
  if (
    p === '/bd/log'    || p.endsWith('/log')
    || p === '/bd/refer' || p.endsWith('/refer')
    || p === '/bd/plan'
    || p.endsWith('/contact')
    || p.endsWith('/contact/new')
    || /\/contact\/[^/]+\/edit$/.test(p)
  ) {
    return null;
  }

  return (
    <nav className={`${s.bottomNav} ${s.bottomNav3}`} aria-label="BD portal navigation">
      <NavLink
        to="/bd"
        end
        className={({ isActive }) => (isActive ? `${s.navItem} ${s.active}` : s.navItem)}
      >
        <span className={s.navItemIcon} aria-hidden><Sun size={20} strokeWidth={1.75} /></span>
        Today
      </NavLink>

      <div className={s.fabContainer}>
        <NavLink to="/bd/log" className={s.fab} aria-label="Log activity">+</NavLink>
      </div>

      <NavLink
        to="/bd/accounts"
        className={({ isActive }) => (isActive ? `${s.navItem} ${s.active}` : s.navItem)}
      >
        <span className={s.navItemIcon} aria-hidden><Building2 size={20} strokeWidth={1.75} /></span>
        Accounts
      </NavLink>
    </nav>
  );
}
