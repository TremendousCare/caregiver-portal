import { useState, useEffect } from 'react';
import { PHASES, CHASE_SCRIPTS } from '../../../lib/constants';
import { isTaskDone } from '../../../lib/utils';
import { getPhaseTasks } from '../../../lib/storage';
import { supabase } from '../../../lib/supabase';
import { OrientationBanner } from '../KanbanBoard';
import { InterviewEvaluationModal } from './InterviewEvaluationModal';
import progress from '../../../styles/progress.module.css';
import btn from '../../../styles/buttons.module.css';
import cg from './caregiver.module.css';

export function PhaseDetail({ caregiver, allCaregivers, activePhase, currentUser, showScripts, onToggleScripts, onUpdateTask, onUpdateTasksBulk, onRefreshTasks, showToast }) {
  const [editingTasks, setEditingTasks] = useState(false);
  const [taskDraft, setTaskDraft] = useState([]);
  const [expanded, setExpanded] = useState(() => localStorage.getItem('tc_phase_expanded') !== 'false');
  const [formModal, setFormModal] = useState(null); // { templateId, taskId }
  const [internalTemplates, setInternalTemplates] = useState([]);

  // Load internal-only survey templates once for the Edit-Checklist dropdown.
  // Cheap single query — these templates change rarely.
  useEffect(() => {
    if (!editingTasks || !supabase) return;
    let cancelled = false;
    supabase
      .from('survey_templates')
      .select('id, name')
      .eq('internal_only', true)
      .eq('enabled', true)
      .then(({ data }) => {
        if (!cancelled) setInternalTemplates(Array.isArray(data) ? data : []);
      });
    return () => { cancelled = true; };
  }, [editingTasks]);

  const PHASE_TASKS = getPhaseTasks();
  const phaseInfo = PHASES.find((p) => p.id === activePhase);
  const phaseTasks = PHASE_TASKS[activePhase];
  const allDone = phaseTasks.every((t) => isTaskDone(caregiver.tasks?.[t.id]));
  const noneDone = phaseTasks.every((t) => !isTaskDone(caregiver.tasks?.[t.id]));

  return (
    <div className={progress.phaseDetail}>
      <div
        className={progress.phaseDetailHeader}
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => { const next = !expanded; setExpanded(next); localStorage.setItem('tc_phase_expanded', String(next)); }}
      >
        <div>
          <h2 className={progress.phaseDetailTitle}>
            <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', marginRight: 6, fontSize: 12 }}>▶</span>
            {phaseInfo?.icon} {phaseInfo?.label}
          </h2>
          {expanded && <p className={progress.phaseDetailSub}>{phaseInfo?.description}</p>}
        </div>
        {expanded && CHASE_SCRIPTS[activePhase] && (
          <button className={btn.scriptBtn} onClick={(e) => { e.stopPropagation(); onToggleScripts(showScripts === activePhase ? null : activePhase); }}>
            📜 {showScripts === activePhase ? 'Hide' : 'Show'} Scripts
          </button>
        )}
      </div>

      {expanded && showScripts === activePhase && CHASE_SCRIPTS[activePhase] && (
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

      {expanded && activePhase === 'orientation' && <OrientationBanner caregivers={allCaregivers} />}

      {expanded && <>
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
                {task.surveyTemplateId && (
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); setFormModal({ templateId: task.surveyTemplateId, taskId: task.id }); }}
                    style={{
                      padding: '4px 10px', borderRadius: 6, border: '1px solid #29BEE4',
                      background: done ? '#F0FDF4' : '#E0F7FB', color: '#0E7B93',
                      fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                    }}
                    title={done ? 'View submitted evaluation' : 'Fill out linked form'}
                  >
                    {done ? 'View Form' : '📝 Fill Out'}
                  </button>
                )}
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
              <select
                value={task.surveyTemplateId || ''}
                onChange={(e) => setTaskDraft((prev) => prev.map((t, i) => i === idx ? { ...t, surveyTemplateId: e.target.value || undefined } : t))}
                title="Link a form to this task (optional)"
                style={{
                  padding: '6px 8px', borderRadius: 6, border: '1px solid #D1D5DB',
                  background: '#FAFBFC', fontSize: 12, fontFamily: 'inherit',
                  maxWidth: 180,
                }}
              >
                <option value="">No linked form</option>
                {internalTemplates.map((t) => (
                  <option key={t.id} value={t.id}>📝 {t.name}</option>
                ))}
              </select>
              <button className={cg.moveBtn} disabled={idx === 0} onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; return arr; })}>↑</button>
              <button className={cg.moveBtn} disabled={idx === taskDraft.length - 1} onClick={() => setTaskDraft((prev) => { const arr = [...prev]; [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]; return arr; })}>↓</button>
              <button className={cg.deleteBtn} onClick={() => setTaskDraft((prev) => prev.filter((_, i) => i !== idx))}>✕</button>
            </div>
          ))}
          <button className={cg.addBtn} onClick={() => setTaskDraft((prev) => [...prev, { id: 'custom_' + Date.now().toString(36), label: '', critical: false }])}>＋ Add Task</button>
        </div>
      )}
      </>}

      {formModal && (
        <InterviewEvaluationModal
          isOpen
          caregiver={caregiver}
          templateId={formModal.templateId}
          taskId={formModal.taskId}
          currentUser={currentUser}
          onUpdateTask={onUpdateTask}
          onClose={() => setFormModal(null)}
          showToast={showToast}
        />
      )}
    </div>
  );
}
