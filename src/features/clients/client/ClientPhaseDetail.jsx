import { useState } from 'react';
import { CLIENT_PHASES, DEFAULT_CLIENT_TASKS, CLIENT_CHASE_SCRIPTS } from '../constants';
import { isTaskDone } from '../utils';
import progress from '../../../styles/progress.module.css';
import btn from '../../../styles/buttons.module.css';
import cl from './client.module.css';

export function ClientPhaseDetail({ client, activePhase, showScripts, onToggleScripts, onUpdateTask, onUpdateTasksBulk, onAddNote }) {
  const [noteText, setNoteText] = useState('');

  const phaseInfo = CLIENT_PHASES.find((p) => p.id === activePhase);
  const phaseTasks = DEFAULT_CLIENT_TASKS[activePhase] || [];
  const allDone = phaseTasks.length > 0 && phaseTasks.every((t) => isTaskDone(client.tasks?.[t.id]));
  const noneDone = phaseTasks.every((t) => !isTaskDone(client.tasks?.[t.id]));

  const handleAddNote = () => {
    if (!noteText.trim()) return;
    onAddNote(client.id, { text: noteText.trim(), type: 'note', phase: activePhase });
    setNoteText('');
  };

  // Filter notes for this phase
  const phaseNotes = (client.notes || [])
    .filter((n) => n.phase === activePhase || !n.phase)
    .sort((a, b) => new Date(b.timestamp || b.date || 0) - new Date(a.timestamp || a.date || 0));

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
      {phaseTasks.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#6B7B8F' }}>Checklist</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {!allDone && (
                <button
                  className={btn.selectAllBtn}
                  onClick={() => {
                    const u = {};
                    phaseTasks.forEach((t) => { u[t.id] = true; });
                    onUpdateTasksBulk(client.id, u);
                  }}
                >
                  ✓ Select All
                </button>
              )}
              {!noneDone && (
                <button
                  className={btn.deselectAllBtn}
                  onClick={() => {
                    const u = {};
                    phaseTasks.forEach((t) => { u[t.id] = false; });
                    onUpdateTasksBulk(client.id, u);
                  }}
                >
                  ✗ Deselect All
                </button>
              )}
            </div>
          </div>

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
        </>
      )}

      {/* Phase Notes */}
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#6B7B8F', marginBottom: 8 }}>Phase Notes</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            style={{
              flex: 1,
              padding: '10px 14px',
              border: '1px solid #E2E8F0',
              borderRadius: 10,
              fontSize: 13,
              fontFamily: 'inherit',
              outline: 'none',
            }}
            placeholder={`Add a note for ${phaseInfo?.label || 'this phase'}...`}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddNote()}
          />
          <button className={btn.primaryBtn} onClick={handleAddNote}>Add</button>
        </div>

        {phaseNotes.length > 0 && (
          <div className={cl.notesList} style={{ maxHeight: 200 }}>
            {phaseNotes.slice(0, 10).map((n, i) => (
              <div key={i} className={cl.noteItem}>
                <div className={cl.noteTimestamp}>
                  {new Date(n.timestamp || n.date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  {n.author && <span style={{ marginLeft: 8, color: '#2E4E8D', fontWeight: 600 }}>— {n.author}</span>}
                </div>
                <div className={cl.noteText}>{n.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
