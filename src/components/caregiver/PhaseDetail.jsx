import { useState } from 'react';
import { PHASES, CHASE_SCRIPTS } from '../../lib/constants';
import { isTaskDone } from '../../lib/utils';
import { getPhaseTasks } from '../../lib/storage';
import { OrientationBanner } from '../KanbanBoard';
import progress from '../../styles/progress.module.css';
import btn from '../../styles/buttons.module.css';
import cg from './caregiver.module.css';

export function PhaseDetail({ caregiver, allCaregivers, activePhase, showScripts, onToggleScripts, onUpdateTask, onUpdateTasksBulk, onRefreshTasks }) {
  const [editingTasks, setEditingTasks] = useState(false);
  const [taskDraft, setTaskDraft] = useState([]);

  const PHASE_TASKS = getPhaseTasks();
  const phaseInfo = PHASES.find((p) => p.id === activePhase);
  const phaseTasks = PHASE_TASKS[activePhase];
  const allDone = phaseTasks.every((t) => isTaskDone(caregiver.tasks?.[t.id]));
  const noneDone = phaseTasks.every((t) => !isTaskDone(caregiver.tasks?.[t.id]));

  return (
    <div className={progress.phaseDetail}>
      <div className={progress.phaseDetailHeader}>
        <div>
          <h2 className={progress.phaseDetailTitle}>{phaseInfo?.icon} {phaseInfo?.label}</h2>
          <p className={progress.phaseDetailSub}>{phaseInfo?.description}</p>
        </div>
        {CHASE_SCRIPTS[activePhase] && (
          <button className={btn.scriptBtn} onClick={() => onToggleScripts(showScripts === activePhase ? null : activePhase)}>
            📜 {showScripts === activePhase ? 'Hide' : 'Show'} Scripts
          </button>
        )}
      </div>

      {showScripts === activePhase && CHASE_SCRIPTS[activePhase] && (
        <div className={cg.scriptsPanel}>
          <h4 className={cg.scriptsPanelTitle}>{CHASE_SCRIPTS[activePhase].title}</h4>
          {CHASE_SCRIPTS[activePhase].scripts.map((s, i) => (
            <div key={i} className={cg.scriptRow}>
              <div className={cg.scriptDay}>{s.day}</div>
              <div style={{ flex: 1 }}>
                <div className={cg.scriptAction}>{s.action}</div>
                {s.script && <div className={cg.scriptText}>"{s.script}"</div>}
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
            {!allDone && <button className={btn.selectAllBtn} onClick={() => { const u = {}; phaseTasks.forEach((t) => { u[t.id] = true; }); onUpdateTasksBulk(caregiver.id, u); }}>✓ Select All</button>}
            {!noneDone && <button className={btn.deselectAllBtn} onClick={() => { const u = {}; phaseTasks.forEach((t) => { u[t.id] = false; }); onUpdateTasksBulk(caregiver.id, u); }}>✗ Deselect All</button>}
            <button className={btn.editBtn} onClick={() => { setTaskDraft(PHASE_TASKS[activePhase].map((t) => ({ ...t }))); setEditingTasks(true); }}>✏️ Edit Checklist</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={() => { PHASE_TASKS[activePhase] = taskDraft.filter((t) => t.label.trim()); onRefreshTasks(); setEditingTasks(false); }}>Save</button>
            <button className={`tc-btn-secondary ${btn.secondaryBtn}`} onClick={() => setEditingTasks(false)}>Cancel</button>
          </div>
        )}
      </div>

      {/* Task list */}
      {!editingTasks ? (
        <div className={cg.taskList}>
          {PHASE_TASKS[activePhase].map((task) => {
            const done = isTaskDone(caregiver.tasks?.[task.id]);
            return (
              <label key={task.id} className={`tc-task-row ${cg.taskRow} ${done ? cg.taskRowDone : ''}`}>
                <div className={`${done ? 'tc-checkbox-done ' : ''}${cg.checkbox} ${done ? cg.checkboxDone : ''}`} style={task.critical ? { borderColor: '#2E4E8D' } : undefined} onClick={() => onUpdateTask(caregiver.id, task.id, !done)}>
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
        <div className={cg.taskList}>
          {taskDraft.map((task, idx) => (
            <div key={task.id} className={cg.row}>
              <span className={cg.handle}>⠿</span>
              <input className={cg.input} value={task.label} onChange={(e) => setTaskDraft((prev) => prev.map((t, i) => i === idx ? { ...t, label: e.target.value } : t))} placeholder="Task description..." />
              <label className={cg.criticalToggle} title="Mark as required">
                <input type="checkbox" checked={!!task.critical} onChange={(e) => setTaskDraft((prev) => prev.map((t, i) => i === idx ? { ...t, critical: e.target.checked } : t))} />
                <span className={cg.criticalLabel}>Required</span>
              </label>
              <button className={cg.moveBtn} disabled={idx === 0} onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; return arr; })}>↑</button>
              <button className={cg.moveBtn} disabled={idx === taskDraft.length - 1} onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]; return arr; })}>↓</button>
              <button className={cg.deleteBtn} onClick={() => setTaskDraft((prev) => prev.filter((_, i) => i !== idx))}>✕</button>
            </div>
          ))}
          <button className={cg.addBtn} onClick={() => setTaskDraft((prev) => [...prev, { id: 'custom_' + Date.now().toString(36), label: '', critical: false }])}>＋ Add Task</button>
        </div>
      )}
    </div>
  );
}
