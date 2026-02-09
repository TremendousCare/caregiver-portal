import { PHASES } from '../lib/constants';
import { getCurrentPhase } from '../lib/utils';
import { styles } from '../styles/theme';

export function Sidebar({ view, setView, filterPhase, setFilterPhase, caregivers, collapsed, setCollapsed }) {
  return (
    <aside
      className={`tc-sidebar${collapsed ? ' collapsed' : ''}`}
      style={{
        ...styles.sidebar,
        width: collapsed ? 64 : 260,
        minWidth: collapsed ? 64 : 260,
      }}
    >
      {/* Logo */}
      <div style={{
        ...styles.logoArea,
        justifyContent: collapsed ? 'center' : 'flex-start',
        padding: collapsed ? '24px 8px 20px' : '24px 20px 20px',
      }}>
        <div style={styles.logoIcon}>TC</div>
        {!collapsed && (
          <div className="sidebar-text">
            <div style={styles.logoTitle}>Tremendous Care</div>
            <div style={styles.logoSub}>Caregiver Portal</div>
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
      <nav style={{ ...styles.nav, padding: collapsed ? '12px 6px 0' : '12px 12px 0' }}>
        {[
          { id: 'dashboard', icon: '⊞', label: 'Dashboard' },
          { id: 'board', icon: '▤', label: 'Caregiver Board' },
          { id: 'add', icon: '＋', label: 'New Caregiver' },
        ].map((item) => (
          <button
            key={item.id}
            className="tc-nav-item"
            style={{
              ...styles.navItem,
              ...(view === item.id ? styles.navActive : {}),
              justifyContent: collapsed ? 'center' : 'flex-start',
              padding: collapsed ? '10px 0' : '10px 12px',
            }}
            onClick={() => setView(item.id)}
            title={item.label}
          >
            <span style={styles.navIcon}>{item.icon}</span>
            {!collapsed && <span className="sidebar-text">{item.label}</span>}
          </button>
        ))}
      </nav>

      {/* Pipeline Overview & Golden Rules */}
      {!collapsed ? (
        <>
          <div style={styles.sidebarSection}>
            <div style={styles.sidebarLabel}>Pipeline Overview</div>
            {PHASES.map((p) => {
              const count = caregivers.filter((c) => getCurrentPhase(c) === p.id).length;
              return (
                <button
                  key={p.id}
                  className="tc-pipeline-item"
                  style={{
                    ...styles.pipelineItem,
                    ...(filterPhase === p.id ? { background: 'rgba(41,190,228,0.12)' } : {}),
                  }}
                  onClick={() => {
                    setFilterPhase(filterPhase === p.id ? 'all' : p.id);
                    setView('dashboard');
                  }}
                >
                  <span>{p.icon}</span>
                  <span style={{ flex: 1, textAlign: 'left' }}>{p.short}</span>
                  <span style={styles.badge}>{count}</span>
                </button>
              );
            })}
          </div>

          <div style={styles.sidebarSection}>
            <div style={styles.sidebarLabel}>Golden Rules</div>
            {[
              { emoji: '⚡', text: '30-min contact window' },
              { emoji: '🕐', text: '24-hr to interview' },
              { emoji: '📅', text: '7-day onboarding sprint' },
              { emoji: '🛡️', text: 'Zero-gap compliance' },
            ].map((rule, i) => (
              <div key={i} style={styles.ruleCard}>
                <div style={styles.ruleEmoji}>{rule.emoji}</div>
                <div style={styles.ruleText}>{rule.text}</div>
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
                  setFilterPhase(filterPhase === p.id ? 'all' : p.id);
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
        </div>
      )}
    </aside>
  );
}
