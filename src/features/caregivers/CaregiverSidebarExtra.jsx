import { useNavigate } from 'react-router-dom';
import { PHASES } from '../../lib/constants';
import { getCurrentPhase, isAwaitingInterviewResponse } from '../../lib/utils';
import { useApp } from '../../shared/context/AppContext';
import { useCaregivers } from '../../shared/context/CaregiverContext';
import layout from '../../styles/layout.module.css';

// ─── Pipeline Overview + Golden Rules (rendered inside Sidebar's Caregivers section) ───
export function CaregiverSidebarExtra() {
  const { sidebarCollapsed } = useApp();
  const { onboardingCaregivers, archivedCaregivers, filterPhase, setFilterPhase } = useCaregivers();
  const navigate = useNavigate();
  const collapsed = sidebarCollapsed;

  const goToDashboard = (phase) => {
    setFilterPhase(phase);
    navigate('/');
  };

  const pendingInterviewCount = onboardingCaregivers.filter(isAwaitingInterviewResponse).length;

  if (!collapsed) {
    return (
      <>
        <div className={layout.sidebarSection}>
          <div className={layout.sidebarLabel}>Pipeline Overview</div>
          {PHASES.map((p) => {
            const count = p.id === 'intake'
              ? onboardingCaregivers.filter((c) => getCurrentPhase(c) === 'intake' && !isAwaitingInterviewResponse(c)).length
              : onboardingCaregivers.filter((c) => getCurrentPhase(c) === p.id).length;
            return (
              <div key={p.id}>
                <button
                  className={layout.pipelineItem}
                  style={filterPhase === p.id ? { background: 'rgba(41,190,228,0.12)' } : {}}
                  onClick={() => goToDashboard(p.id)}
                >
                  <span style={{ flex: 1, textAlign: 'left' }}>{p.short}</span>
                  <span className={layout.badge}>{count}</span>
                </button>
                {p.id === 'intake' && pendingInterviewCount > 0 && (
                  <button
                    className={layout.pipelineItem}
                    style={{
                      paddingLeft: 32,
                      fontSize: 12,
                      opacity: 0.85,
                      ...(filterPhase === 'intake_pending' ? { background: 'rgba(41,190,228,0.12)', opacity: 1 } : {}),
                    }}
                    onClick={() => goToDashboard('intake_pending')}
                    title="Interview link sent, awaiting response"
                  >
                    <span style={{ flex: 1, textAlign: 'left' }}>Pending Interview</span>
                    <span className={layout.badge}>{pendingInterviewCount}</span>
                  </button>
                )}
              </div>
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
              <span style={{ flex: 1, textAlign: 'left' }}>Archived</span>
              <span className={layout.badge}>{archivedCaregivers.length}</span>
            </button>
          )}
        </div>
      </>
    );
  }

  // Collapsed view — compact phase icons
  return (
    <div style={{ padding: '12px 6px', borderTop: '1px solid #2A2A2A', marginTop: 4 }}>
      {PHASES.map((p) => {
        const count = p.id === 'intake'
          ? onboardingCaregivers.filter((c) => getCurrentPhase(c) === 'intake' && !isAwaitingInterviewResponse(c)).length
          : onboardingCaregivers.filter((c) => getCurrentPhase(c) === p.id).length;
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
