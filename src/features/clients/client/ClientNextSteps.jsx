import { useMemo } from 'react';
import { CLIENT_PHASES, DEFAULT_CLIENT_TASKS } from '../constants';
import { getClientPhase, isTaskDone, getClientPhaseProgress } from '../utils';

// ─── Overdue Thresholds (in milliseconds) ────────────────────
const OVERDUE_THRESHOLDS = {
  new_lead: 1 * 60 * 60 * 1000,          // 1 hour
  initial_contact: 2 * 24 * 60 * 60 * 1000, // 2 days
  consultation: 3 * 24 * 60 * 60 * 1000,    // 3 days
  assessment: 7 * 24 * 60 * 60 * 1000,      // 7 days
  proposal: 3 * 24 * 60 * 60 * 1000,        // 3 days
};

// ─── Helpers ─────────────────────────────────────────────────

function getPhaseEntryTime(client, phase) {
  // For new_lead, use createdAt
  if (phase === 'new_lead') {
    if (!client.createdAt) return null;
    return typeof client.createdAt === 'number'
      ? client.createdAt
      : new Date(client.createdAt).getTime();
  }
  // For other phases, use phaseTimestamps
  const ts = client.phaseTimestamps?.[phase];
  if (!ts) return null;
  return typeof ts === 'number' ? ts : new Date(ts).getTime();
}

function formatOverdueTime(ms) {
  if (ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(ms / 86400000);

  if (days > 0) return `${days} day${days !== 1 ? 's' : ''} overdue`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''} overdue`;
  if (minutes > 0) return `${minutes} min${minutes !== 1 ? 's' : ''} overdue`;
  return 'Just overdue';
}

// ─── Main Component ──────────────────────────────────────────

export function ClientNextSteps({ client, onUpdateTask, onAddNote, currentUser }) {
  const phase = getClientPhase(client);
  const phaseInfo = CLIENT_PHASES.find((p) => p.id === phase);

  // Calculate all action items for the current phase
  const actionItems = useMemo(() => {
    // Terminal phases handled separately
    if (['won', 'lost', 'nurture'].includes(phase)) return [];

    const tasks = DEFAULT_CLIENT_TASKS[phase];
    if (!tasks) return [];

    const threshold = OVERDUE_THRESHOLDS[phase];
    const entryTime = getPhaseEntryTime(client, phase);
    const now = Date.now();
    const elapsed = entryTime ? now - entryTime : 0;
    const isOverThreshold = threshold && entryTime ? elapsed > threshold : false;
    const overdueMs = threshold && entryTime ? elapsed - threshold : 0;

    return tasks
      .filter((t) => !isTaskDone(client.tasks?.[t.id]))
      .map((t) => ({
        ...t,
        overdue: isOverThreshold,
        overdueMs: isOverThreshold ? overdueMs : 0,
        overdueLabel: isOverThreshold ? formatOverdueTime(overdueMs) : null,
      }))
      .sort((a, b) => {
        // Critical overdue first, then non-critical overdue, then rest
        if (a.overdue && a.critical && !(b.overdue && b.critical)) return -1;
        if (b.overdue && b.critical && !(a.overdue && a.critical)) return 1;
        if (a.overdue && !b.overdue) return -1;
        if (b.overdue && !a.overdue) return 1;
        if (a.critical && !b.critical) return -1;
        if (b.critical && !a.critical) return 1;
        return 0;
      });
  }, [client, phase]);

  // Check if all current phase tasks are done
  const { done, total } = getClientPhaseProgress(client, phase);
  const allDone = total > 0 && done === total;

  // Next phase info
  const currentIndex = CLIENT_PHASES.findIndex((p) => p.id === phase);
  const nextPhase = CLIENT_PHASES[currentIndex + 1];
  const canAdvance = allDone && nextPhase && !['lost', 'nurture'].includes(nextPhase.id);

  // ─── Terminal Phase Renders ────────────────────────────────

  if (phase === 'won') {
    return (
      <div style={styles.container}>
        <div style={styles.successBanner}>
          <div style={styles.successIcon}>&#x1F389;</div>
          <div>
            <div style={styles.successTitle}>Client Won!</div>
            <div style={styles.successText}>
              This client has been converted. Review the Won phase tasks to complete onboarding.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'lost') {
    return (
      <div style={styles.container}>
        <div style={styles.lostBanner}>
          <div style={styles.lostIcon}>&#x274C;</div>
          <div>
            <div style={styles.lostTitle}>Client Lost</div>
            <div style={styles.lostText}>
              {client.lostReason
                ? `Reason: ${client.lostReason}`
                : 'No reason recorded. Consider documenting why this client was lost.'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'nurture') {
    const followUpDate = client.followUpDate
      ? new Date(client.followUpDate).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        })
      : null;
    return (
      <div style={styles.container}>
        <div style={styles.nurtureBanner}>
          <div style={styles.nurtureIcon}>&#x1F331;</div>
          <div>
            <div style={styles.nurtureTitle}>Nurture Mode</div>
            <div style={styles.nurtureText}>
              {followUpDate
                ? `Follow-up scheduled for ${followUpDate}. Check in when the time comes.`
                : 'No follow-up date set. Consider scheduling one to stay in touch.'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Active Phase Render ───────────────────────────────────

  const hasOverdue = actionItems.some((t) => t.overdue);

  return (
    <div style={{
      ...styles.container,
      ...(hasOverdue ? styles.containerUrgent : {}),
    }}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.fireIcon}>&#x1F525;</span>
          <h3 style={styles.title}>Next Steps</h3>
          {hasOverdue && (
            <span style={styles.urgentBadge}>
              ACTION NEEDED
            </span>
          )}
        </div>
        <div style={styles.headerRight}>
          <span style={styles.phaseLabel}>
            {phaseInfo?.icon} {phaseInfo?.label}
          </span>
          <span style={styles.progressLabel}>
            {done}/{total} tasks done
          </span>
        </div>
      </div>

      {/* Action Items */}
      <div style={styles.taskList}>
        {actionItems.map((task) => {
          const isOverdueCritical = task.overdue && task.critical;
          const isOverdueNonCritical = task.overdue && !task.critical;

          let itemStyle = { ...styles.taskItem };
          if (isOverdueCritical) {
            itemStyle = { ...itemStyle, ...styles.taskItemCritical };
          } else if (isOverdueNonCritical) {
            itemStyle = { ...itemStyle, ...styles.taskItemWarning };
          }

          return (
            <div key={task.id} style={itemStyle}>
              {/* Checkbox */}
              <button
                style={styles.taskCheckbox}
                onClick={() => onUpdateTask(client.id, task.id, true)}
                title="Mark as complete"
              >
                <span style={styles.taskCheckboxInner} />
              </button>

              {/* Task content */}
              <div style={styles.taskContent}>
                <div style={styles.taskLabel}>
                  {task.critical && (
                    <span style={styles.criticalStar}>&#x2B50;</span>
                  )}
                  {task.label}
                </div>
                {task.overdueLabel && (
                  <div style={{
                    ...styles.overdueTag,
                    color: isOverdueCritical ? '#991B1B' : '#854D0E',
                  }}>
                    &#x23F0; {task.overdueLabel}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Phase advancement suggestion */}
        {canAdvance && (
          <div style={styles.advanceBanner}>
            <span style={styles.advanceIcon}>&#x1F680;</span>
            <div style={styles.advanceText}>
              All {phaseInfo?.label} tasks complete &mdash; ready to advance to{' '}
              <strong>{nextPhase.label}</strong>
            </div>
          </div>
        )}

        {/* All caught up state */}
        {actionItems.length === 0 && !canAdvance && (
          <div style={styles.allDoneMessage}>
            &#x2705; All tasks for this phase are up to date.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inline Styles ───────────────────────────────────────────

const styles = {
  container: {
    background: '#FFFFFF',
    borderRadius: 18,
    border: '1px solid rgba(0,0,0,0.05)',
    padding: '22px 26px',
    marginBottom: 20,
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
  },
  containerUrgent: {
    border: '2px solid #FECDC8',
    background: 'linear-gradient(135deg, #FFFFFF 0%, #FFFBFA 100%)',
    boxShadow: '0 4px 16px rgba(220,53,69,0.08)',
  },

  // Header
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
    flexWrap: 'wrap',
    gap: 10,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  fireIcon: {
    fontSize: 22,
  },
  title: {
    margin: 0,
    fontSize: 17,
    fontWeight: 700,
    fontFamily: "'Outfit', sans-serif",
    color: '#0F1724',
    letterSpacing: -0.2,
  },
  urgentBadge: {
    fontSize: 10,
    fontWeight: 800,
    color: '#DC3545',
    background: '#FEE2E2',
    padding: '3px 10px',
    borderRadius: 6,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  phaseLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#556270',
    background: '#F4F6FA',
    padding: '4px 10px',
    borderRadius: 8,
  },
  progressLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#7A8BA0',
  },

  // Task list
  taskList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  taskItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 14,
    padding: '13px 16px',
    borderRadius: 12,
    background: '#F9FAFB',
    border: '1px solid #E2E8F0',
    transition: 'all 0.15s',
  },
  taskItemCritical: {
    background: 'linear-gradient(135deg, #FEF2F2 0%, #FEE2E2 100%)',
    border: '1px solid #FECACA',
    boxShadow: '0 2px 8px rgba(220,53,69,0.08)',
  },
  taskItemWarning: {
    background: 'linear-gradient(135deg, #FFFBEB 0%, #FEF9C3 100%)',
    border: '1px solid #FDE68A',
    boxShadow: '0 2px 8px rgba(217,119,6,0.06)',
  },

  // Checkbox
  taskCheckbox: {
    width: 26,
    height: 26,
    borderRadius: 8,
    border: '2px solid #D5DCE6',
    background: '#FFFFFF',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    padding: 0,
    marginTop: 1,
    transition: 'all 0.2s cubic-bezier(0.4,0,0.2,1)',
  },
  taskCheckboxInner: {
    width: 8,
    height: 8,
    borderRadius: 2,
    background: 'transparent',
  },

  // Task content
  taskContent: {
    flex: 1,
    minWidth: 0,
  },
  taskLabel: {
    fontSize: 14,
    fontWeight: 500,
    color: '#1A1A1A',
    lineHeight: 1.5,
  },
  criticalStar: {
    marginRight: 6,
    fontSize: 13,
  },
  overdueTag: {
    fontSize: 12,
    fontWeight: 700,
    marginTop: 4,
    letterSpacing: 0.1,
  },

  // Advance banner
  advanceBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 18px',
    borderRadius: 12,
    background: 'linear-gradient(135deg, #ECFDF3 0%, #D1FAE5 100%)',
    border: '1px solid #BBF7D0',
    marginTop: 4,
  },
  advanceIcon: {
    fontSize: 20,
    flexShrink: 0,
  },
  advanceText: {
    fontSize: 14,
    fontWeight: 500,
    color: '#166534',
    lineHeight: 1.5,
  },

  // All done
  allDoneMessage: {
    fontSize: 14,
    color: '#16A34A',
    fontWeight: 600,
    textAlign: 'center',
    padding: '14px 16px',
    background: '#F0FDF4',
    borderRadius: 12,
    border: '1px solid #BBF7D0',
  },

  // Terminal phase banners
  successBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '18px 22px',
    borderRadius: 14,
    background: 'linear-gradient(135deg, #ECFDF3 0%, #D1FAE5 100%)',
    border: '1px solid #BBF7D0',
  },
  successIcon: { fontSize: 32, flexShrink: 0 },
  successTitle: {
    fontSize: 17, fontWeight: 700, color: '#166534',
    fontFamily: "'Outfit', sans-serif", marginBottom: 4,
  },
  successText: { fontSize: 14, color: '#15803D', fontWeight: 500, lineHeight: 1.5 },

  lostBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '18px 22px',
    borderRadius: 14,
    background: 'linear-gradient(135deg, #FEF2F2 0%, #FEE2E2 100%)',
    border: '1px solid #FECACA',
  },
  lostIcon: { fontSize: 32, flexShrink: 0 },
  lostTitle: {
    fontSize: 17, fontWeight: 700, color: '#991B1B',
    fontFamily: "'Outfit', sans-serif", marginBottom: 4,
  },
  lostText: { fontSize: 14, color: '#DC3545', fontWeight: 500, lineHeight: 1.5 },

  nurtureBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '18px 22px',
    borderRadius: 14,
    background: 'linear-gradient(135deg, #F5F3FF 0%, #EDE9FE 100%)',
    border: '1px solid #DDD6FE',
  },
  nurtureIcon: { fontSize: 32, flexShrink: 0 },
  nurtureTitle: {
    fontSize: 17, fontWeight: 700, color: '#6D28D9',
    fontFamily: "'Outfit', sans-serif", marginBottom: 4,
  },
  nurtureText: { fontSize: 14, color: '#7C3AED', fontWeight: 500, lineHeight: 1.5 },
};
