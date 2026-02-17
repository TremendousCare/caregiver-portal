import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import layout from '../../styles/layout.module.css';

// ─── Collapsible sidebar section ───
function SidebarSection({ section, collapsed }) {
  const [expanded, setExpanded] = useState(true);
  const location = useLocation();
  const navigate = useNavigate();

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  return (
    <div>
      {/* Section header — collapsible when sidebar is expanded */}
      {!collapsed && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            width: '100%', padding: '14px 14px 8px', border: 'none',
            background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <span style={{
            fontSize: 10, textTransform: 'uppercase', letterSpacing: '1.8px',
            color: 'rgba(255,255,255,0.25)', fontWeight: 700,
          }}>
            {section.label}
          </span>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', transition: 'transform 0.2s', transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
            ▾
          </span>
        </button>
      )}

      {/* Nav items */}
      {(expanded || collapsed) && (
        <nav style={{ padding: collapsed ? '0 6px' : '0 12px' }}>
          {section.items.map((item) => (
            <button
              key={item.id}
              className={`${layout.navItem} ${isActive(item.path) ? layout.navActive : ''}`}
              style={{
                justifyContent: collapsed ? 'center' : 'flex-start',
                padding: collapsed ? '10px 0' : '10px 12px',
              }}
              onClick={() => {
                navigate(item.path);
                if (item.onNavigate) item.onNavigate();
              }}
              title={item.label}
            >
              <span className={layout.navIcon}>{item.icon}</span>
              {!collapsed && <span className="sidebar-text">{item.label}</span>}
            </button>
          ))}
        </nav>
      )}

      {/* Extra content (e.g. Pipeline Overview, Golden Rules) */}
      {expanded && section.extra}
    </div>
  );
}

// ─── Main Sidebar ───
export function Sidebar({ sections }) {
  const { sidebarCollapsed, setSidebarCollapsed, currentUserName, isAdmin, handleLogout } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const collapsed = sidebarCollapsed;

  return (
    <aside
      className={`${layout.sidebar} tc-sidebar${collapsed ? ' collapsed' : ''}`}
      style={{
        width: collapsed ? 64 : 260,
        minWidth: collapsed ? 64 : 260,
      }}
    >
      {/* Logo */}
      <div style={{
        ...{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid rgba(255,255,255,0.06)' },
        justifyContent: collapsed ? 'center' : 'flex-start',
        padding: collapsed ? '24px 8px 20px' : '24px 20px 20px',
      }}>
        <div className={layout.logoIcon}>TC</div>
        {!collapsed && (
          <div className="sidebar-text">
            <div className={layout.logoTitle}>Tremendous Care</div>
            <div className={layout.logoSub}>Platform</div>
          </div>
        )}
      </div>

      {/* Collapse Toggle */}
      <button
        className="tc-collapse-btn"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '100%', padding: '8px 0', border: 'none',
          borderBottom: '1px solid #2A2A2A', background: 'transparent',
          color: '#6B7B8F', fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
        }}
        onClick={() => setSidebarCollapsed(!collapsed)}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? '▸' : '◂'} {!collapsed && <span style={{ fontSize: 12, marginLeft: 6 }}>Collapse</span>}
      </button>

      {/* Module Sections */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sections.map((section) => (
          <SidebarSection key={section.id} section={section} collapsed={collapsed} />
        ))}

        {/* Settings (admin only, always at bottom of nav) */}
        {isAdmin && (
          <nav style={{ padding: collapsed ? '4px 6px' : '4px 12px', borderTop: '1px solid rgba(255,255,255,0.05)', marginTop: 4 }}>
            <button
              className={`${layout.navItem} ${location.pathname === '/settings' ? layout.navActive : ''}`}
              style={{
                justifyContent: collapsed ? 'center' : 'flex-start',
                padding: collapsed ? '10px 0' : '10px 12px',
              }}
              onClick={() => navigate('/settings')}
              title="Settings"
            >
              <span className={layout.navIcon}>⚙</span>
              {!collapsed && <span className="sidebar-text">Settings</span>}
            </button>
          </nav>
        )}
      </div>

      {/* User info & Logout */}
      <div style={{
        marginTop: 'auto',
        padding: collapsed ? '12px 6px' : '12px 16px',
        borderTop: '1px solid #2A2A2A',
      }}>
        {!collapsed && currentUserName && (
          <div style={{
            fontSize: 12, color: '#8BA3C7', marginBottom: 8,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            👤 {currentUserName}
          </div>
        )}
        <button
          className={layout.navItem}
          style={{
            justifyContent: collapsed ? 'center' : 'flex-start',
            padding: collapsed ? '10px 0' : '10px 12px',
            color: '#DC3545',
          }}
          onClick={handleLogout}
          title="Sign out"
        >
          <span className={layout.navIcon}>⏻</span>
          {!collapsed && <span className="sidebar-text">Sign Out</span>}
        </button>
      </div>
    </aside>
  );
}
