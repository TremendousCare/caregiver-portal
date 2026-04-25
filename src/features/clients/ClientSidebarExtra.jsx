import { useNavigate } from 'react-router-dom';
import { CLIENT_PHASES } from './constants';
import { getClientPhase, isClientOverdue } from './utils';
import { useApp } from '../../shared/context/AppContext';
import { useClients } from '../../shared/context/ClientContext';
import layout from '../../styles/layout.module.css';

// ─── Pipeline Overview + Key Metrics (rendered inside Sidebar's Clients section) ───
export function ClientSidebarExtra() {
  const { sidebarCollapsed } = useApp();
  const { activeClients, archivedClients, filterPhase, setFilterPhase } = useClients();
  const navigate = useNavigate();
  const collapsed = sidebarCollapsed;

  const goToDashboard = (phase) => {
    setFilterPhase(phase);
    navigate('/clients');
  };

  if (!collapsed) {
    const overdueCount = activeClients.filter(isClientOverdue).length;

    return (
      <>
        <div className={layout.sidebarSection}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 8 }}>
            <div className={layout.sidebarLabel}>Pipeline Overview</div>
            <button
              onClick={() => navigate('/clients/add-lead')}
              title="Add new lead to pipeline"
              style={{
                background: 'transparent', border: 'none', color: '#8BA3C7',
                cursor: 'pointer', fontSize: 14, padding: '2px 6px', borderRadius: 4,
                fontFamily: 'inherit', lineHeight: 1,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              ＋ New Lead
            </button>
          </div>
          {CLIENT_PHASES.map((p) => {
            const count = activeClients.filter((c) => getClientPhase(c) === p.id).length;
            return (
              <button
                key={p.id}
                className={layout.pipelineItem}
                style={filterPhase === p.id ? { background: 'rgba(41,190,228,0.12)' } : {}}
                onClick={() => goToDashboard(p.id)}
              >
                <span style={{ flex: 1, textAlign: 'left' }}>{p.short}</span>
                <span className={layout.badge}>{count}</span>
              </button>
            );
          })}
          {archivedClients.length > 0 && (
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
              <span style={{ flex: 1, textAlign: 'left' }}>Archived</span>
              <span className={layout.badge}>{archivedClients.length}</span>
            </button>
          )}
        </div>

        <div className={layout.sidebarSection}>
          <div className={layout.sidebarLabel}>Key Metrics</div>
          {[
            `Active Leads: ${activeClients.length}`,
            `Overdue: ${overdueCount}`,
          ].map((text, i) => (
            <div key={i} style={{ padding: '7px 14px', marginBottom: 2, fontSize: 11, color: 'rgba(255,255,255,0.3)', lineHeight: 1.4, fontWeight: 500 }}>
              {text}
            </div>
          ))}
        </div>
      </>
    );
  }

  // Collapsed view — compact phase icons
  return (
    <div style={{ padding: '12px 6px', borderTop: '1px solid #2A2A2A', marginTop: 4 }}>
      {CLIENT_PHASES.map((p) => {
        const count = activeClients.filter((c) => getClientPhase(c) === p.id).length;
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
      {archivedClients.length > 0 && (
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
          title={`Archived (${archivedClients.length})`}
        >
          📦
          <span style={{ position: 'absolute', top: 2, right: 6, fontSize: 9, fontWeight: 700, color: '#29BEE4' }}>
            {archivedClients.length}
          </span>
        </button>
      )}
    </div>
  );
}
