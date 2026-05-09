import { NavLink, useLocation } from 'react-router-dom';
import s from './BdPortal.module.css';

export function BottomNav() {
  const location = useLocation();
  // The capture screen is "modal" — we don't show the bottom nav
  // there so the form gets the full screen.
  if (location.pathname === '/bd/log' || location.pathname.endsWith('/log')) return null;

  return (
    <nav className={`${s.bottomNav} ${s.bottomNav3}`} aria-label="BD portal navigation">
      <NavLink
        to="/bd"
        end
        className={({ isActive }) => (isActive ? `${s.navItem} ${s.active}` : s.navItem)}
      >
        <span className={s.navItemIcon} aria-hidden>☀️</span>
        Today
      </NavLink>

      <div className={s.fabContainer}>
        <NavLink to="/bd/log" className={s.fab} aria-label="Log activity">+</NavLink>
      </div>

      <NavLink
        to="/bd/accounts"
        className={({ isActive }) => (isActive ? `${s.navItem} ${s.active}` : s.navItem)}
      >
        <span className={s.navItemIcon} aria-hidden>🏥</span>
        Accounts
      </NavLink>
    </nav>
  );
}
