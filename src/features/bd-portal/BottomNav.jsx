import { NavLink, useLocation } from 'react-router-dom';
import { Sun, Building2 } from 'lucide-react';
import { useBdViewAs } from './context/BdViewAsContext';
import s from './BdPortal.module.css';

export function BottomNav() {
  const location = useLocation();
  const { isReadOnly } = useBdViewAs();
  // The capture, referral, contact-edit, mileage-form, and route-
  // builder screens are "modal" — we don't show the bottom nav there
  // so the form gets the full screen. The mileage *list* still shows
  // the nav (it's a top-level destination from Today).
  const p = location.pathname;
  if (
    p === '/bd/log'    || p.endsWith('/log')
    || p === '/bd/refer' || p.endsWith('/refer')
    || p === '/bd/plan'
    || p.endsWith('/contact')
    || p.endsWith('/contact/new')
    || /\/contact\/[^/]+\/edit$/.test(p)
    || p === '/bd/mileage/new'
    || /^\/bd\/mileage\/[^/]+$/.test(p)
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
        {/* Logging is a write — hidden while an owner is auditing a rep
            (read-only). The container stays to preserve the 3-column
            grid spacing. */}
        {!isReadOnly && (
          <NavLink to="/bd/log" className={s.fab} aria-label="Log activity">+</NavLink>
        )}
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
