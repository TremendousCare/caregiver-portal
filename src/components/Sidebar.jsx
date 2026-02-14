import { PHASES } from '../lib/constants';
import { getCurrentPhase } from '../lib/utils';
import layout from '../styles/layout.module.css';

export function Sidebar({ view, setView, filterPhase, setFilterPhase, caregivers, archivedCount = 0, collapsed, setCollapsed, currentUser, isAdmin, onLogout }) {
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
            <div className={layout.logoSub}>Caregiver Portal</div>
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
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? '▸' : '◂'} {!collapsed && <span style={{ fontSize: 12, marginLeft: 6 }}>Collapse</span>}
      </button>

      {/* Navigation */}
      <nav style={{ padding: collapsed ? '12px 6px 0' : '12px 12px 0' }}>
        {[
          { id: 'dashboard', icon: '⊞', label: 'Dashboard' },
          { id: 'board', icon: '▤', label: 'Caregiver Board' },
          { id: 'add', icon: '＋', label: 'New Caregiver' },
          ...(isAdmin ? [{ id: 'settings', icon: '⚙', label: 'Settings' }] : []),
        ].map((item) => (
          <button
            key={item.id}
            className={`${layout.navItem} ${view === item.id ? layout.navActive : ''}`}
            style={{
              justifyContent: collapsed ? 'center' : 'flex-start',
              padding: collapsed ? '10px 0' : '10px 12px',
            }}
            onClick={() => { setView(item.id); if (item.id === 'dashboard') setFilterPhase('all'); }}
            title={item.label}
          >
            <span className={layout.navIcon}>{item.icon}</span>
            {!collapsed && <span className="sidebar-text">{item.label}</span>}
          </button>
        ))}
      </nav>

      {/* Pipeline Overview & Golden Rules */}
      {!collapsed ? (
        <>
          <div className={layout.sidebarSection}>
            <div className={layout.sidebarLabel}>Pipeline Overview</div>
            {PHASES.map((p) => {
              const count = caregivers.filter((c) => getCurrentPhase(c) === p.id).length;
              return (
                <button
                  key={p.id}
                  className={layout.pipelineItem}
                  style={filterPhase === p.id ? { background: 'rgba(41,190,228,0.12)' } : {}}
                  onClick={() => {
                    setFilterPhase(p.id);
                    setView('dashboard');
                  }}
                >
                  <span>{p.icon}</span>
                  <span style={{ flex: 1, textAlign: 'left' }}>{p.short}</span>
                  <span className={layout.badge}>{count}</span>
                </button>
              );
            })}
            {archivedCount > 0 && (
              <button
                className={layout.pipelineItem}
                style={{
                  marginTop: 4,
                  borderTop: '1px solid #2A2A2A',
                  paddingTop: 10,
                  ...(filterPhase === 'archived' ? { background: 'rgba(41,190,228,0.12)' } : {}),
                }}
                onClick={() => {
                  setFilterPhase('archived');
                  setView('dashboard');
                }}
              >
                <span>📦</span>
                <span style={{ flex: 1, textAlign: 'left' }}>Archived</span>
                <span className={layout.badge}>{archivedCount}</span>
              </button>
            )}
          </div>

          <div className={layout.sidebarSection}>
            <div className={layout.sidebarLabel}>Golden Rules</div>
            {[
              { emoji: '⚡', text: '30-min contact window' },
              { emoji: '🕐', text: '24-hr to interview' },
              { emoji: '📅', text: '7-day onboarding sprint' },
              { emoji: '🛡️', text: 'Zero-gap compliance' },
            ].map((rule, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', marginBottom: 2 }}>
                <div style={{ fontSize: 13 }}>{rule.emoji}</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', lineHeight: 1.4, fontWeight: 500 }}>{rule.text}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ padding: '12px 6px', borderTop: '1px solid #2A2A2A', marginTop: 4 }}>
          {PHASES.map((p) => {
            const count = caregivers.filter((c) => getCurrentPhase(c) === p.id).length;
            return (
              <button
                key={p.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: '100%', padding: '8px 0', border: 'none', borderRadius: 6,
                  background: filterPhase === p.id ? 'rgba(41,190,228,0.12)' : 'transparent',
                  color: '#8BA3C7', fontSize: 16, cursor: 'pointer',
                  fontFamily: 'inherit', position: 'relative',
                }}
                onClick={() => {
                  setFilterPhase(p.id);
                  setView('dashboard');
                }}
                title={`${p.short} (${count})`}
              >
                {p.icon}
                {count > 0 && (
                  <span style={{
                    position: 'absolute', top: 2, right: 6,
                    fontSize: 9, fontWeight: 700, color: '#29BEE4',
                  }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
          {archivedCount > 0 && (
            <button
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '100%', padding: '8px 0', border: 'none', borderRadius: 6,
                background: filterPhase === 'archived' ? 'rgba(41,190,228,0.12)' : 'transparent',
                color: '#8BA3C7', fontSize: 16, cursor: 'pointer',
                fontFamily: 'inherit', position: 'relative',
                marginTop: 4,
              }}
              onClick={() => {
                setFilterPhase('archived');
                setView('dashboard');
              }}
              title={`Archived (${archivedCount})`}
            >
              📦
              <span style={{ position: 'absolute', top: 2, right: 6, fontSize: 9, fontWeight: 700, color: '#29BEE4' }}>
                {archivedCount}
              </span>
            </button>
          )}
        </div>
      )}

      {/* User info & Logout */}
      <div style={{
        marginTop: 'auto',
        padding: collapsed ? '12px 6px' : '12px 16px',
        borderTop: '1px solid #2A2A2A',
      }}>
        {!collapsed && currentUser && (
          <div style={{
            fontSize: 12, color: '#8BA3C7', marginBottom: 8,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            👤 {currentUser}
          </div>
        )}
        {onLogout && (
          <button
            className={layout.navItem}
            style={{
              justifyContent: collapsed ? 'center' : 'flex-start',
              padding: collapsed ? '10px 0' : '10px 12px',
              color: '#DC3545',
            }}
            onClick={onLogout}
            title="Sign out"
          >
            <span className={layout.navIcon}>⏻</span>
            {!collapsed && <span className="sidebar-text">Sign Out</span>}
          </button>
        )}
      </div>
    </aside>
  );
}
