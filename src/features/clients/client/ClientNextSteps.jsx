import { useMemo, useState } from 'react';
import {
  Flame,
  Star,
  Rocket,
  CheckCircle2,
  XCircle,
  Sprout,
  Check,
} from 'lucide-react';
import { CLIENT_PHASES, CLIENT_CHASE_SCRIPTS } from '../constants';
import { getClientPhaseTasks } from '../storage';
import { getClientPhase, isTaskDone, getClientPhaseProgress } from '../utils';
import { ClientPhaseIcon } from '../lib/clientPhaseIcon';
import btn from '../../../styles/buttons.module.css';
import cl from './client.module.css';
import progress from '../../../styles/progress.module.css';

// ─── Main Component ──────────────────────────────────────────
// Absorbs the old ClientPhaseDetail card: scripts panel, edit-checklist
// mode, select-all/deselect-all, and the full task list (including
// already-completed tasks, rendered dimmed). The previous "Next Steps"
// card surfaced only incomplete tasks AND there was a separate "Phase
// Detail" card at the bottom of the page showing the same checklist
// again. One source of truth now.

export function ClientNextSteps({
  client,
  onUpdateTask,
  onUpdateTasksBulk,
  onRefreshTasks,
  onAddNote,
  currentUser,
}) {
  const phase = getClientPhase(client);
  const phaseInfo = CLIENT_PHASES.find((p) => p.id === phase);

  const [showScripts, setShowScripts] = useState(false);
  const [editingTasks, setEditingTasks] = useState(false);
  const [taskDraft, setTaskDraft] = useState([]);

  const CLIENT_PHASE_TASKS = getClientPhaseTasks();
  const phaseTasks = CLIENT_PHASE_TASKS[phase] || [];
  const allDone = phaseTasks.length > 0 && phaseTasks.every((t) => isTaskDone(client.tasks?.[t.id]));
  const noneDone = phaseTasks.every((t) => !isTaskDone(client.tasks?.[t.id]));

  // Sorted task list: completed always last, critical incomplete first.
  const sortedTasks = useMemo(() => {
    if (['won', 'lost', 'nurture'].includes(phase)) return [];
    if (!phaseTasks.length) return [];

    return phaseTasks
      .map((t) => ({ ...t, done: isTaskDone(client.tasks?.[t.id]) }))
      .sort((a, b) => {
        if (a.done && !b.done) return 1;
        if (b.done && !a.done) return -1;
        if (a.critical && !b.critical) return -1;
        if (b.critical && !a.critical) return 1;
        return 0;
      });
  }, [client, phase, phaseTasks]);

  // Progress + advancement
  const { done, total } = getClientPhaseProgress(client, phase);
  const currentIndex = CLIENT_PHASES.findIndex((p) => p.id === phase);
  const nextPhase = CLIENT_PHASES[currentIndex + 1];
  const canAdvance = allDone && nextPhase && !['lost', 'nurture'].includes(nextPhase.id);

  // First chase script for the active phase, used for the Speed-to-Lead
  // (new_lead) inline callout and as the first row when scripts are
  // expanded.
  const scriptBundle = CLIENT_CHASE_SCRIPTS[phase];
  const firstScript = scriptBundle?.scripts?.[0];

  // ─── Terminal Phase Renders ────────────────────────────────

  // Won clients are now in the "active" section — no banner or pipeline UI.
  if (phase === 'won') {
    return null;
  }

  if (phase === 'lost') {
    return (
      <div style={styles.container}>
        <div style={styles.lostBanner}>
          <div style={styles.lostIcon}><XCircle size={32} strokeWidth={2} aria-hidden /></div>
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
          <div style={styles.nurtureIcon}><Sprout size={32} strokeWidth={2} aria-hidden /></div>
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

  const startEditing = () => {
    setTaskDraft((CLIENT_PHASE_TASKS[phase] || []).map((t) => ({ ...t })));
    setEditingTasks(true);
  };

  const saveEdits = () => {
    CLIENT_PHASE_TASKS[phase] = taskDraft.filter((t) => t.label.trim());
    if (onRefreshTasks) onRefreshTasks();
    setEditingTasks(false);
  };

  const selectAll = () => {
    const u = {};
    phaseTasks.forEach((t) => { u[t.id] = true; });
    onUpdateTasksBulk?.(client.id, u);
  };

  const deselectAll = () => {
    const u = {};
    phaseTasks.forEach((t) => { u[t.id] = false; });
    onUpdateTasksBulk?.(client.id, u);
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.fireIcon}><Flame size={20} strokeWidth={2} aria-hidden /></span>
          <h3 style={styles.title}>Next Steps</h3>
        </div>
        <div style={styles.headerRight}>
          <span style={{ ...styles.phaseLabel, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ClientPhaseIcon phaseId={phase} size={12} />
            {phaseInfo?.label}
          </span>
          <span style={styles.progressLabel}>
            {done}/{total} tasks done
          </span>
        </div>
      </div>

      {/* Phase description */}
      {phaseInfo?.description && (
        <div style={styles.phaseDescription}>{phaseInfo.description}</div>
      )}

      {/* Action buttons row */}
      <div style={styles.actionRow}>
        {scriptBundle && (
          <button
            className={btn.secondaryBtn}
            onClick={() => setShowScripts((s) => !s)}
          >
            {showScripts ? 'Hide Scripts' : 'Show Scripts'}
          </button>
        )}
        {!editingTasks && phaseTasks.length > 0 && (
          <>
            {!allDone && onUpdateTasksBulk && (
              <button className={btn.secondaryBtn} onClick={selectAll}>
                ✓ Select All
              </button>
            )}
            {!noneDone && onUpdateTasksBulk && (
              <button className={btn.secondaryBtn} onClick={deselectAll}>
                ✗ Deselect All
              </button>
            )}
            <button className={btn.secondaryBtn} onClick={startEditing}>
              Edit Checklist
            </button>
          </>
        )}
        {editingTasks && (
          <>
            <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={saveEdits}>
              Save
            </button>
            <button className={`tc-btn-secondary ${btn.secondaryBtn}`} onClick={() => setEditingTasks(false)}>
              Cancel
            </button>
          </>
        )}
      </div>

      {/* Speed-to-Lead inline callout: only renders for new_lead and
          surfaces the first chase script (Minute 0-15: Call + Text)
          inline so the rep doesn't have to click into a Scripts panel
          to see what to say. */}
      {phase === 'new_lead' && firstScript && !showScripts && (
        <div style={styles.speedToLeadCallout}>
          <div style={styles.speedToLeadHeader}>
            <span style={styles.speedToLeadTag}>{firstScript.day}</span>
            <span style={styles.speedToLeadAction}>{firstScript.action}</span>
          </div>
          {firstScript.script && (
            <div style={styles.speedToLeadScript}>&ldquo;{firstScript.script}&rdquo;</div>
          )}
        </div>
      )}

      {/* Scripts panel (expanded view) */}
      {showScripts && scriptBundle && (
        <div className={cl.scriptsPanel}>
          <h4 className={cl.scriptsPanelTitle}>{scriptBundle.title}</h4>
          {scriptBundle.scripts.map((s, i) => (
            <div key={i} className={cl.scriptRow}>
              <div className={cl.scriptDay}>{s.day}</div>
              <div style={{ flex: 1 }}>
                <div className={cl.scriptAction}>{s.action}</div>
                {s.script && <div className={cl.scriptText}>&ldquo;{s.script}&rdquo;</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Task list — view mode */}
      {!editingTasks && (
        <div style={styles.taskList}>
          {sortedTasks.map((task) => {
            const itemStyle = task.done
              ? { ...styles.taskItem, ...styles.taskItemDone }
              : styles.taskItem;

            return (
              <div key={task.id} style={itemStyle}>
                <button
                  style={{
                    ...styles.taskCheckbox,
                    ...(task.done ? styles.taskCheckboxDone : {}),
                  }}
                  onClick={() => onUpdateTask(client.id, task.id, !task.done)}
                  title={task.done ? 'Mark as not done' : 'Mark as complete'}
                >
                  {task.done && <Check size={14} strokeWidth={3} color="#fff" aria-hidden />}
                </button>

                <div style={styles.taskContent}>
                  <div style={{
                    ...styles.taskLabel,
                    ...(task.done ? styles.taskLabelDone : {}),
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}>
                    {task.critical && !task.done && (
                      <Star size={13} strokeWidth={2} fill="#D97706" color="#D97706" aria-hidden />
                    )}
                    <span>{task.label}</span>
                    {task.critical && !task.done && (
                      <span className={progress.criticalBadge} style={{ marginLeft: 4 }}>Required</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Phase advancement suggestion */}
          {canAdvance && (
            <div style={styles.advanceBanner}>
              <span style={styles.advanceIcon}>
                <Rocket size={20} strokeWidth={2} aria-hidden />
              </span>
              <div style={styles.advanceText}>
                All {phaseInfo?.label} tasks complete &mdash; ready to advance to{' '}
                <strong>{nextPhase.label}</strong>
              </div>
            </div>
          )}

          {/* Empty state — no tasks configured for this phase */}
          {sortedTasks.length === 0 && !canAdvance && (
            <div style={{ ...styles.allDoneMessage, display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
              <CheckCircle2 size={16} strokeWidth={2} aria-hidden />
              No tasks configured for this phase.
            </div>
          )}
        </div>
      )}

      {/* Task list — edit mode */}
      {editingTasks && (
        <div className={cl.taskList}>
          {taskDraft.map((task, idx) => (
            <div key={task.id} className={cl.row}>
              <span className={cl.handle}>⠿</span>
              <input
                className={cl.input}
                value={task.label}
                onChange={(e) => setTaskDraft((prev) => prev.map((t, i) => i === idx ? { ...t, label: e.target.value } : t))}
                placeholder="Task description..."
              />
              <label className={cl.criticalToggle} title="Mark as required">
                <input
                  type="checkbox"
                  checked={!!task.critical}
                  onChange={(e) => setTaskDraft((prev) => prev.map((t, i) => i === idx ? { ...t, critical: e.target.checked } : t))}
                />
                <span className={cl.criticalLabel}>Required</span>
              </label>
              <button
                className={cl.moveBtn}
                disabled={idx === 0}
                onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; return arr; })}
              >
                ↑
              </button>
              <button
                className={cl.moveBtn}
                disabled={idx === taskDraft.length - 1}
                onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]; return arr; })}
              >
                ↓
              </button>
              <button
                className={cl.deleteBtn}
                onClick={() => setTaskDraft((prev) => prev.filter((_, i) => i !== idx))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className={cl.addBtn}
            onClick={() => setTaskDraft((prev) => [...prev, { id: 'custom_' + Date.now().toString(36), label: '', critical: false }])}
          >
            ＋ Add Task
          </button>
        </div>
      )}
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

  // Header
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
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

  // Phase description (was in ClientPhaseDetail)
  phaseDescription: {
    fontSize: 13,
    color: '#6B7B8F',
    marginBottom: 12,
    lineHeight: 1.5,
  },

  // Action buttons row
  actionRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 14,
  },

  // Speed-to-Lead callout (new_lead only)
  speedToLeadCallout: {
    padding: '14px 16px',
    borderRadius: 12,
    background: 'linear-gradient(135deg, #FFF7ED 0%, #FFEDD5 100%)',
    border: '1px solid #FED7AA',
    marginBottom: 14,
  },
  speedToLeadHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
    flexWrap: 'wrap',
  },
  speedToLeadTag: {
    fontSize: 10,
    fontWeight: 800,
    color: '#C2410C',
    background: '#FED7AA',
    padding: '3px 10px',
    borderRadius: 6,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  speedToLeadAction: {
    fontSize: 14,
    fontWeight: 700,
    color: '#9A3412',
  },
  speedToLeadScript: {
    fontSize: 13,
    color: '#7C2D12',
    lineHeight: 1.55,
    fontStyle: 'italic',
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
  taskItemDone: {
    background: '#FFFFFF',
    border: '1px solid #F0F2F6',
    padding: '8px 16px',
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
  taskCheckboxDone: {
    background: '#16A34A',
    borderColor: '#16A34A',
  },
  taskCheckmark: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
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
  taskLabelDone: {
    fontSize: 13,
    color: '#9CA3AF',
    textDecoration: 'line-through',
    fontWeight: 400,
  },
  criticalStar: {
    marginRight: 6,
    fontSize: 13,
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
