import { useState, useRef, useEffect } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { CLIENT_PHASES } from '../constants';
import {
  getClientPhase,
  getClientOverallProgress,
  getClientPhaseProgress,
  getDaysSinceCreated,
} from '../utils';
import { ClientPhaseIcon } from '../lib/clientPhaseIcon';
import { closePendingSuggestionForAction } from '../../../lib/agentLoopClosure';

// ClientPipelineStepper
// =====================
// Replaces the old ClientProgressOverview card. One source of truth for
// "where is this client in the pipeline" — a horizontal stepper showing
// each active funnel phase as a clickable node, plus a "Change status"
// menu for the terminal phases (won / lost / nurture). Compared to the
// previous design it removes three competing surfaces (the phase
// dropdown, the per-phase tabs with % indicators, and the row of
// status buttons) and exposes one canonical control.

const TERMINAL_PHASE_IDS = new Set(['won', 'lost', 'nurture']);

export function ClientPipelineStepper({ client, onUpdateClient }) {
  const currentPhase = getClientPhase(client);
  const currentPhaseInfo = CLIENT_PHASES.find((p) => p.id === currentPhase);
  const overallPct = getClientOverallProgress(client);
  const days = getDaysSinceCreated(client);

  // Stepper shows only the linear funnel path. Won is the bright-green
  // endpoint at the right edge; lost / nurture are off-path and live
  // behind the Change Status menu.
  const funnelPhases = CLIENT_PHASES.filter((p) => p.id !== 'lost' && p.id !== 'nurture');
  const currentIndex = funnelPhases.findIndex((p) => p.id === currentPhase);
  const isTerminal = TERMINAL_PHASE_IDS.has(currentPhase);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const changePhase = (newPhase) => {
    if (!newPhase || newPhase === currentPhase) return;
    const fromPhase = currentPhase;
    onUpdateClient(client.id, {
      phase: newPhase,
      phaseTimestamps: {
        ...client.phaseTimestamps,
        [newPhase]: client.phaseTimestamps?.[newPhase] || Date.now(),
      },
    });
    // Phase 1.5 follow-up — close any matching pending ai_suggestion
    // for this (client, update_phase). Fire-and-forget; failure must
    // never affect the UX.
    closePendingSuggestionForAction({
      entityType: 'client',
      entityId: client.id,
      actionType: 'update_phase',
      params: { from_phase: fromPhase || null, to_phase: newPhase },
    }).catch((err) => {
      console.warn('[ClientPipelineStepper] suggestion-close failed (non-fatal):', err);
    });
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.title}>Pipeline</span>
          {currentPhaseInfo && isTerminal && (
            <span
              style={{
                ...styles.statusBadge,
                background: `${currentPhaseInfo.color}18`,
                color: currentPhaseInfo.color,
                border: `1px solid ${currentPhaseInfo.color}30`,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <ClientPhaseIcon phaseId={currentPhase} size={12} />
              {currentPhaseInfo.label}
            </span>
          )}
        </div>
        <div style={styles.headerRight}>
          <span style={styles.meta}>Day {days}</span>
          <span style={styles.dot}>·</span>
          <span style={styles.meta}>{overallPct}% pipeline</span>
          <div style={styles.menuWrap} ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              style={{
                ...styles.menuTrigger,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              Change status <ChevronDown size={12} strokeWidth={2} aria-hidden />
            </button>
            {menuOpen && (
              <div style={styles.menu} role="menu">
                {['won', 'lost', 'nurture'].map((phaseId) => {
                  const info = CLIENT_PHASES.find((p) => p.id === phaseId);
                  if (!info) return null;
                  const isSelected = currentPhase === phaseId;
                  return (
                    <button
                      key={phaseId}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        changePhase(phaseId);
                        setMenuOpen(false);
                      }}
                      style={{
                        ...styles.menuItem,
                        ...(isSelected ? styles.menuItemSelected : {}),
                      }}
                    >
                      <span style={{ color: info.color, marginRight: 8, display: 'inline-flex', alignItems: 'center' }}>
                        <ClientPhaseIcon phaseId={phaseId} size={14} />
                      </span>
                      {info.label}
                      {isSelected && (
                        <span style={styles.menuItemCheck}>
                          <Check size={14} strokeWidth={2.5} aria-hidden />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        style={{
          ...styles.stepper,
          opacity: isTerminal && currentPhase !== 'won' ? 0.45 : 1,
        }}
      >
        {funnelPhases.map((phase, idx) => {
          const isCurrent = phase.id === currentPhase;
          // Past = before current in the linear funnel order. After a
          // status change to lost/nurture the stepper dims as a whole
          // (above), so "past" here only matters for the visible
          // ladder. Won as current marks the entire ladder past.
          let isPast = false;
          if (currentPhase === 'won') {
            isPast = phase.id !== 'won';
          } else if (!isTerminal && currentIndex >= 0) {
            isPast = idx < currentIndex;
          }
          const isFuture = !isCurrent && !isPast;
          const { pct } = getClientPhaseProgress(client, phase.id);

          let nodeStyle = styles.node;
          if (isCurrent) nodeStyle = { ...nodeStyle, ...styles.nodeCurrent, borderColor: phase.color, color: phase.color };
          else if (isPast) nodeStyle = { ...nodeStyle, ...styles.nodePast };
          else if (isFuture) nodeStyle = { ...nodeStyle, ...styles.nodeFuture };

          return (
            <div key={phase.id} style={styles.stepWrap}>
              <button
                type="button"
                onClick={() => changePhase(phase.id)}
                style={nodeStyle}
                title={phase.description}
              >
                <span style={styles.nodeIcon}>
                  {isPast
                    ? <Check size={16} strokeWidth={2.5} aria-hidden />
                    : <ClientPhaseIcon phaseId={phase.id} size={16} />}
                </span>
                <div style={styles.nodeBody}>
                  <div style={styles.nodeLabel}>{phase.short || phase.label}</div>
                  {isCurrent && phase.id !== 'won' && (
                    <div style={styles.nodeProgress}>{pct}% done</div>
                  )}
                </div>
              </button>
              {idx < funnelPhases.length - 1 && (
                <div style={{
                  ...styles.connector,
                  background: idx < currentIndex ? '#16A34A' : '#E2E8F0',
                }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  container: {
    background: '#FFFFFF',
    borderRadius: 18,
    border: '1px solid rgba(0,0,0,0.05)',
    padding: '20px 24px',
    marginBottom: 20,
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
    flexWrap: 'wrap',
    gap: 12,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    color: '#0F1724',
    fontFamily: "'Outfit', sans-serif",
    letterSpacing: -0.2,
  },
  statusBadge: {
    padding: '3px 10px',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 700,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  meta: {
    fontSize: 12,
    fontWeight: 600,
    color: '#7A8BA0',
  },
  dot: {
    fontSize: 12,
    color: '#CBD5E1',
  },
  menuWrap: {
    position: 'relative',
    marginLeft: 8,
  },
  menuTrigger: {
    background: '#FFFFFF',
    border: '1px solid #E2E8F0',
    borderRadius: 8,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    color: '#374151',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  menu: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    minWidth: 160,
    background: '#FFFFFF',
    border: '1px solid #E2E8F0',
    borderRadius: 10,
    boxShadow: '0 10px 25px rgba(0,0,0,0.10)',
    padding: 6,
    zIndex: 20,
  },
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    padding: '8px 10px',
    fontSize: 13,
    fontWeight: 500,
    color: '#1A1A1A',
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  menuItemSelected: {
    background: '#F4F6FA',
    fontWeight: 700,
  },
  menuItemCheck: {
    marginLeft: 'auto',
    color: '#16A34A',
    fontWeight: 700,
  },

  // Stepper
  stepper: {
    display: 'flex',
    alignItems: 'stretch',
    gap: 0,
    overflowX: 'auto',
    transition: 'opacity 0.15s',
  },
  stepWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 0,
    flex: 1,
    minWidth: 0,
  },
  node: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    borderRadius: 12,
    border: '1px solid #E2E8F0',
    background: '#FFFFFF',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.12s',
    flex: 1,
    minWidth: 0,
  },
  nodeCurrent: {
    background: '#FFFFFF',
    borderWidth: 2,
    boxShadow: '0 2px 8px rgba(46,78,141,0.08)',
  },
  nodePast: {
    background: '#F0FDF4',
    borderColor: '#BBF7D0',
    color: '#166534',
  },
  nodeFuture: {
    background: '#FAFBFC',
    borderColor: '#E2E8F0',
    color: '#94A3B8',
    opacity: 0.85,
  },
  nodeIcon: {
    fontSize: 16,
    flexShrink: 0,
  },
  nodeBody: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1,
  },
  nodeLabel: {
    fontSize: 13,
    fontWeight: 700,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  nodeProgress: {
    fontSize: 11,
    fontWeight: 500,
    opacity: 0.8,
    marginTop: 1,
  },
  connector: {
    height: 2,
    flex: '0 0 12px',
    minWidth: 12,
    alignSelf: 'center',
  },
};
