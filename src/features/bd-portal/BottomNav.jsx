import { NavLink } from 'react-router-dom';
import s from './BdPortal.module.css';

const items = [
  { to: '/bd',          label: 'Today',    icon: '☀️',  end: true  },
  { to: '/bd/accounts', label: 'Accounts', icon: '🏥',  end: false },
];

export function BottomNav() {
  return (
    <nav className={s.bottomNav} aria-label="BD portal navigation">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            isActive ? `${s.navItem} ${s.active}` : s.navItem
          }
        >
          <span className={s.navItemIcon} aria-hidden>{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
