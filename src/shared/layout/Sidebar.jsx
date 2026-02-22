import { useState, useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import layout from '../../styles/layout.module.css';

// ─── LocalStorage key for persisting collapsed sections ───
// Tracks which sections are expanded (default: all collapsed)
const STORAGE_KEY = 'tc_sidebar_expanded';

function loadCollapsedSections() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveCollapsedSections(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

// ─── Collapsible sidebar section ───
function SidebarSection({ section, sidebarCollapsed, isExpanded, onToggle }) {
  const location = useLocation();
  const navigate = useNavigate();
  const contentRef = useRef(null);
  const [contentHeight, setContentHeight] = useState(isExpanded ? 'auto' : 0);
  const isFirstRender = useRef(true);

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  // Measure and animate content height
  useEffect(() => {
    if (isFirstRender.current) {
      // No animation on first render — just set immediately
      setContentHeight(isExpanded ? 'auto' : 0);
      isFirstRender.current = false;
      return;
    }
    if (!contentRef.current) return;
    if (isExpanded) {
      const h = contentRef.current.scrollHeight;
      setContentHeight(h);
      const timer = setTimeout(() => setContentHeight('auto'), 250);
      return () => clearTimeout(timer);
    } else {
      // Force a reflow before collapsing to animate from actual height
      const h = contentRef.current.scrollHeight;
      setContentHeight(h);
      requestAnimationFrame(() => { setContentHeight(0); });
    }
  }, [isExpanded]);

  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      {/* Section header — collapsible when sidebar is expanded */}
      {!sidebarCollapsed && (
        <button
          onClick={onToggle}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            width: '100%', padding: '14px 16px 8px', border: 'none',
            background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <span style={{
            fontSize: 10, textTransform: 'uppercase', letterSpacing: '1.8px',
            color: isExpanded ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.2)',
            fontWeight: 700, transition: 'color 0.2s',
          }}>
            {section.label}
          </span>
          <span style={{
            fontSize: 9, color: 'rgba(255,255,255,0.2)',
            transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1)',
            transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            display: 'inline-block',
          }}>
            ▾
          </span>
        </button>
      )}

      {/* Animated collapsible content */}
      <div
        ref={contentRef}
        style={{
          height: sidebarCollapsed ? 'auto' : contentHeight,
          overflow: (sidebarCollapsed || contentHeight === 'auto') ? 'visible' : 'hidden',
          transition: contentHeight === 'auto' ? 'none' : 'height 0.25s cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        {/* Nav items */}
        <nav style={{ padding: sidebarCollapsed ? '0 6px' : '0 12px 4px' }}>
          {section.items.map((item) => (
            <button
              key={item.id}
              className={`${layout.navItem} ${isActive(item.path) ? layout.navActive : ''}`}
              style={{
                justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                padding: sidebarCollapsed ? '10px 0' : '10px 12px',
              }}
              onClick={() => {
                navigate(item.path);
                if (item.onNavigate) item.onNavigate();
              }}
              title={item.label}
            >
              <span className={layout.navIcon}>{item.icon}</span>
              {!sidebarCollapsed && <span className="sidebar-text">{item.label}</span>}
            </button>
          ))}
        </nav>

        {/* Extra content (e.g. Pipeline Overview) */}
        {!sidebarCollapsed && section.extra}
      </div>
    </div>
  );
}

// ─── Main Sidebar ───
export function Sidebar({ sections }) {
  const { sidebarCollapsed, setSidebarCollapsed, currentUserName, isAdmin, handleLogout } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const collapsed = sidebarCollapsed;

  // Persistent expand/collapse state per section
  const [collapsedSections, setCollapsedSections] = useState(loadCollapsedSections);

  const toggleSection = useCallback((sectionId) => {
    setCollapsedSections(prev => {
      const next = { ...prev, [sectionId]: !prev[sectionId] };
      saveCollapsedSections(next);
      return next;
    });
  }, []);

  // Build full sections list including Settings (admin only)
  const allSections = [...sections];
  if (isAdmin) {
    allSections.push({
      id: 'settings',
      label: 'Settings',
      items: [
        { id: 'settings-main', path: '/settings', icon: '⚙', label: 'Admin Settings' },
      ],
    });
  }

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
        {allSections.map((section) => (
          <SidebarSection
            key={section.id}
            section={section}
            sidebarCollapsed={collapsed}
            isExpanded={!!collapsedSections[section.id]}
            onToggle={() => toggleSection(section.id)}
          />
        ))}
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
