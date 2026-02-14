import { useState } from 'react';
import { PHASES, CHASE_SCRIPTS } from '../../lib/constants';
import { isTaskDone } from '../../lib/utils';
import { getPhaseTasks } from '../../lib/storage';
import { OrientationBanner } from '../KanbanBoard';
import { styles, taskEditStyles } from '../../styles/theme';

export function PhaseDetail({ caregiver, allCaregivers, activePhase, showScripts, onToggleScripts, onUpdateTask, onUpdateTasksBulk, onRefreshTasks }) {
  const [editingTasks, setEditingTasks] = useState(false);
  const [taskDraft, setTaskDraft] = useState([]);

  const PHASE_TASKS = getPhaseTasks();
  const phaseInfo = PHASES.find((p) => p.id === activePhase);
  const phaseTasks = PHASE_TASKS[activePhase];
  const allDone = phaseTasks.every((t) => isTaskDone(caregiver.tasks?.[t.id]));
  const noneDone = phaseTasks.every((t) => !isTaskDone(caregiver.tasks?.[t.id]));

  return (
    <div style={styles.phaseDetail}>
      <div style={styles.phaseDetailHeader}>
        <div>
          <h2 style={styles.phaseDetailTitle}>{phaseInfo?.icon} {phaseInfo?.label}</h2>
          <p style={styles.phaseDetailSub}>{phaseInfo?.description}</p>
        </div>
        {CHASE_SCRIPTS[activePhase] && (
          <button style={styles.scriptBtn} onClick={() => onToggleScripts(showScripts === activePhase ? null : activePhase)}>
            📜 {showScripts === activePhase ? 'Hide' : 'Show'} Scripts
          </button>
        )}
      </div>

      {showScripts === activePhase && CHASE_SCRIPTS[activePhase] && (
        <div style={styles.scriptsPanel}>
          <h4 style={styles.scriptsPanelTitle}>{CHASE_SCRIPTS[activePhase].title}</h4>
          {CHASE_SCRIPTS[activePhase].scripts.map((s, i) => (
            <div key={i} style={styles.scriptRow}>
              <div style={styles.scriptDay}>{s.day}</div>
              <div style={{ flex: 1 }}>
                <div style={styles.scriptAction}>{s.action}</div>
                {s.script && <div style={styles.scriptText}>"{s.script}"</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {activePhase === 'orientation' && <OrientationBanner caregivers={allCaregivers} />}

      {/* Tasks header with bulk controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#6B7B8F' }}>{editingTasks ? 'Editing Checklist' : 'Checklist'}</span>
        {!editingTasks ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {!allDone && <button style={styles.selectAllBtn} onClick={() => { const u = {}; phaseTasks.forEach((t) => { u[t.id] = true; }); onUpdateTasksBulk(caregiver.id, u); }}>✓ Select All</button>}
            {!noneDone && <button style={styles.deselectAllBtn} onClick={() => { const u = {}; phaseTasks.forEach((t) => { u[t.id] = false; }); onUpdateTasksBulk(caregiver.id, u); }}>✗ Deselect All</button>}
            <button style={styles.editBtn} onClick={() => { setTaskDraft(PHASE_TASKS[activePhase].map((t) => ({ ...t }))); setEditingTasks(true); }}>✏️ Edit Checklist</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="tc-btn-primary" style={styles.primaryBtn} onClick={() => { PHASE_TASKS[activePhase] = taskDraft.filter((t) => t.label.trim()); onRefreshTasks(); setEditingTasks(false); }}>Save</button>
            <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={() => setEditingTasks(false)}>Cancel</button>
          </div>
        )}
      </div>

      {/* Task list */}
      {!editingTasks ? (
        <div style={styles.taskList}>
          {PHASE_TASKS[activePhase].map((task) => {
            const done = isTaskDone(caregiver.tasks?.[task.id]);
            return (
              <label key={task.id} className="tc-task-row" style={{ ...styles.taskRow, ...(done ? styles.taskRowDone : {}) }}>
                <div className={done ? 'tc-checkbox-done' : ''} style={{ ...styles.checkbox, ...(done ? styles.checkboxDone : {}), ...(task.critical ? { borderColor: '#2E4E8D' } : {}) }} onClick={() => onUpdateTask(caregiver.id, task.id, !done)}>
                  {done && '✓'}
                </div>
                <div style={{ flex: 1 }}>
                  <span style={{ ...(done ? { textDecoration: 'line-through', opacity: 0.5 } : {}) }}>{task.label}</span>
                  {task.critical && !done && <span style={styles.criticalBadge}>Required</span>}
                </div>
              </label>
            );
          })}
        </div>
      ) : (
        <div style={styles.taskList}>
          {taskDraft.map((task, idx) => (
            <div key={task.id} style={taskEditStyles.row}>
              <span style={taskEditStyles.handle}>⠿</span>
              <input style={taskEditStyles.input} value={task.label} onChange={(e) => setTaskDraft((prev) => prev.map((t, i) => i === idx ? { ...t, label: e.target.value } : t))} placeholder="Task description..." />
              <label style={taskEditStyles.criticalToggle} title="Mark as required">
                <input type="checkbox" checked={!!task.critical} onChange={(e) => setTaskDraft((prev) => prev.map((t, i) => i === idx ? { ...t, critical: e.target.checked } : t))} />
                <span style={taskEditStyles.criticalLabel}>Required</span>
              </label>
              <button style={taskEditStyles.moveBtn} disabled={idx === 0} onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; return arr; })}>↑</button>
              <button style={taskEditStyles.moveBtn} disabled={idx === taskDraft.length - 1} onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]; return arr; })}>↓</button>
              <button style={taskEditStyles.deleteBtn} onClick={() => setTaskDraft((prev) => prev.filter((_, i) => i !== idx))}>✕</button>
            </div>
          ))}
          <button style={taskEditStyles.addBtn} onClick={() => setTaskDraft((prev) => [...prev, { id: 'custom_' + Date.now().toString(36), label: '', critical: false }])}>＋ Add Task</button>
        </div>
      )}
    </div>
  );
}
