import { useState } from 'react';
import { CLIENT_PHASES, CLIENT_CHASE_SCRIPTS } from '../constants';
import { getClientPhaseTasks } from '../storage';
import { isTaskDone } from '../utils';
import progress from '../../../styles/progress.module.css';
import btn from '../../../styles/buttons.module.css';
import cl from './client.module.css';
// Phase Notes section removed — all notes consolidated in Activity Log

export function ClientPhaseDetail({ client, activePhase, showScripts, onToggleScripts, onUpdateTask, onUpdateTasksBulk, onRefreshTasks }) {
  const [editingTasks, setEditingTasks] = useState(false);
  const [taskDraft, setTaskDraft] = useState([]);

  const CLIENT_PHASE_TASKS = getClientPhaseTasks();
  const phaseInfo = CLIENT_PHASES.find((p) => p.id === activePhase);
  const phaseTasks = CLIENT_PHASE_TASKS[activePhase] || [];
  const allDone = phaseTasks.length > 0 && phaseTasks.every((t) => isTaskDone(client.tasks?.[t.id]));
  const noneDone = phaseTasks.every((t) => !isTaskDone(client.tasks?.[t.id]));

  return (
    <div className={progress.phaseDetail}>
      <div className={progress.phaseDetailHeader}>
        <div>
          <h2 className={progress.phaseDetailTitle}>{phaseInfo?.icon} {phaseInfo?.label}</h2>
          <p className={progress.phaseDetailSub}>{phaseInfo?.description}</p>
        </div>
        {CLIENT_CHASE_SCRIPTS[activePhase] && (
          <button className={btn.scriptBtn} onClick={() => onToggleScripts(showScripts === activePhase ? null : activePhase)}>
            📜 {showScripts === activePhase ? 'Hide' : 'Show'} Scripts
          </button>
        )}
      </div>

      {/* Chase Scripts */}
      {showScripts === activePhase && CLIENT_CHASE_SCRIPTS[activePhase] && (
        <div className={cl.scriptsPanel}>
          <h4 className={cl.scriptsPanelTitle}>{CLIENT_CHASE_SCRIPTS[activePhase].title}</h4>
          {CLIENT_CHASE_SCRIPTS[activePhase].scripts.map((s, i) => (
            <div key={i} className={cl.scriptRow}>
              <div className={cl.scriptDay}>{s.day}</div>
              <div style={{ flex: 1 }}>
                <div className={cl.scriptAction}>{s.action}</div>
                {s.script && <div className={cl.scriptText}>"{s.script}"</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Task Checklist */}
      {(phaseTasks.length > 0 || editingTasks) && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#6B7B8F' }}>{editingTasks ? 'Editing Checklist' : 'Checklist'}</span>
            {!editingTasks ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {!allDone && (
                  <button className={btn.selectAllBtn} onClick={() => { const u = {}; phaseTasks.forEach((t) => { u[t.id] = true; }); onUpdateTasksBulk(client.id, u); }}>
                    ✓ Select All
                  </button>
                )}
                {!noneDone && (
                  <button className={btn.deselectAllBtn} onClick={() => { const u = {}; phaseTasks.forEach((t) => { u[t.id] = false; }); onUpdateTasksBulk(client.id, u); }}>
                    ✗ Deselect All
                  </button>
                )}
                <button className={btn.editBtn} onClick={() => { setTaskDraft((CLIENT_PHASE_TASKS[activePhase] || []).map((t) => ({ ...t }))); setEditingTasks(true); }}>
                  ✏️ Edit Checklist
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6 }}>
                <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={() => { CLIENT_PHASE_TASKS[activePhase] = taskDraft.filter((t) => t.label.trim()); if (onRefreshTasks) onRefreshTasks(); setEditingTasks(false); }}>Save</button>
                <button className={`tc-btn-secondary ${btn.secondaryBtn}`} onClick={() => setEditingTasks(false)}>Cancel</button>
              </div>
            )}
          </div>

          {/* Task list — normal mode vs editing mode */}
          {!editingTasks ? (
            <div className={cl.taskList}>
              {phaseTasks.map((task) => {
                const done = isTaskDone(client.tasks?.[task.id]);
                return (
                  <label key={task.id} className={`${cl.taskRow} ${done ? cl.taskRowDone : ''}`}>
                    <div
                      className={`${cl.checkbox} ${done ? cl.checkboxDone : ''}`}
                      style={task.critical ? { borderColor: '#2E4E8D' } : undefined}
                      onClick={() => onUpdateTask(client.id, task.id, !done)}
                    >
                      {done && '✓'}
                    </div>
                    <div style={{ flex: 1 }}>
                      <span style={done ? { textDecoration: 'line-through', opacity: 0.5 } : {}}>{task.label}</span>
                      {task.critical && !done && <span className={progress.criticalBadge}>Required</span>}
                    </div>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className={cl.taskList}>
              {taskDraft.map((task, idx) => (
                <div key={task.id} className={cl.row}>
                  <span className={cl.handle}>⠿</span>
                  <input className={cl.input} value={task.label} onChange={(e) => setTaskDraft((prev) => prev.map((t, i) => i === idx ? { ...t, label: e.target.value } : t))} placeholder="Task description..." />
                  <label className={cl.criticalToggle} title="Mark as required">
                    <input type="checkbox" checked={!!task.critical} onChange={(e) => setTaskDraft((prev) => prev.map((t, i) => i === idx ? { ...t, critical: e.target.checked } : t))} />
                    <span className={cl.criticalLabel}>Required</span>
                  </label>
                  <button className={cl.moveBtn} disabled={idx === 0} onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; return arr; })}>↑</button>
                  <button className={cl.moveBtn} disabled={idx === taskDraft.length - 1} onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]; return arr; })}>↓</button>
                  <button className={cl.deleteBtn} onClick={() => setTaskDraft((prev) => prev.filter((_, i) => i !== idx))}>✕</button>
                </div>
              ))}
              <button className={cl.addBtn} onClick={() => setTaskDraft((prev) => [...prev, { id: 'custom_' + Date.now().toString(36), label: '', critical: false }])}>＋ Add Task</button>
            </div>
          )}
        </>
      )}

    </div>
  );
}
