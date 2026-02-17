import { useNavigate } from 'react-router-dom';
import { PHASES } from '../../lib/constants';
import { getCurrentPhase } from '../../lib/utils';
import { useApp } from '../../shared/context/AppContext';
import { useCaregivers } from '../../shared/context/CaregiverContext';
import layout from '../../styles/layout.module.css';

// ─── Pipeline Overview + Golden Rules (rendered inside Sidebar's Caregivers section) ───
export function CaregiverSidebarExtra() {
  const { sidebarCollapsed } = useApp();
  const { activeCaregivers, archivedCaregivers, filterPhase, setFilterPhase } = useCaregivers();
  const navigate = useNavigate();
  const collapsed = sidebarCollapsed;

  const goToDashboard = (phase) => {
    setFilterPhase(phase);
    navigate('/');
  };

  if (!collapsed) {
    return (
      <>
        <div className={layout.sidebarSection}>
          <div className={layout.sidebarLabel}>Pipeline Overview</div>
          {PHASES.map((p) => {
            const count = activeCaregivers.filter((c) => getCurrentPhase(c) === p.id).length;
            return (
              <button
                key={p.id}
                className={layout.pipelineItem}
                style={filterPhase === p.id ? { background: 'rgba(41,190,228,0.12)' } : {}}
                onClick={() => goToDashboard(p.id)}
              >
                <span>{p.icon}</span>
                <span style={{ flex: 1, textAlign: 'left' }}>{p.short}</span>
                <span className={layout.badge}>{count}</span>
              </button>
            );
          })}
          {archivedCaregivers.length > 0 && (
            <button
              className={layout.pipelineItem}
              style={{
                marginTop: 4,
                borderTop: '1px solid #2A2A2A',
                paddingTop: 10,
                ...(filterPhase === 'archived' ? { background: 'rgba(41,190,228,0.12)' } : {}),
              }}
              onClick={() => goToDashboard('archived')}
            >
              <span>📦</span>
              <span style={{ flex: 1, textAlign: 'left' }}>Archived</span>
              <span className={layout.badge}>{archivedCaregivers.length}</span>
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
    );
  }

  // Collapsed view — compact phase icons
  return (
    <div style={{ padding: '12px 6px', borderTop: '1px solid #2A2A2A', marginTop: 4 }}>
      {PHASES.map((p) => {
        const count = activeCaregivers.filter((c) => getCurrentPhase(c) === p.id).length;
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
            onClick={() => goToDashboard(p.id)}
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
      {archivedCaregivers.length > 0 && (
        <button
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '100%', padding: '8px 0', border: 'none', borderRadius: 6,
            background: filterPhase === 'archived' ? 'rgba(41,190,228,0.12)' : 'transparent',
            color: '#8BA3C7', fontSize: 16, cursor: 'pointer',
            fontFamily: 'inherit', position: 'relative',
            marginTop: 4,
          }}
          onClick={() => goToDashboard('archived')}
          title={`Archived (${archivedCaregivers.length})`}
        >
          📦
          <span style={{ position: 'absolute', top: 2, right: 6, fontSize: 9, fontWeight: 700, color: '#29BEE4' }}>
            {archivedCaregivers.length}
          </span>
        </button>
      )}
    </div>
  );
}
