import { useState } from 'react';
import { PHASES, CHASE_SCRIPTS, GREEN_LIGHT_ITEMS } from '../lib/constants';
import { getCurrentPhase, getCalculatedPhase, getOverallProgress, getPhaseProgress, getDaysSinceApplication, isGreenLight } from '../lib/utils';
import { getPhaseTasks } from '../lib/storage';
import { OrientationBanner } from './KanbanBoard';
import { styles, taskEditStyles } from '../styles/theme';

function EditField({ label, value, onChange, type = 'text' }) {
  return (
    <div style={styles.field}>
      <label style={styles.fieldLabel}>{label}</label>
      <input style={styles.fieldInput} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function CaregiverDetail({
  caregiver, allCaregivers, onBack, onUpdateTask, onUpdateTasksBulk,
  onAddNote, onDelete, onUpdateCaregiver, onRefreshTasks,
  showScripts, setShowScripts, showGreenLight, setShowGreenLight,
}) {
  const [noteText, setNoteText] = useState('');
  const [activePhase, setActivePhase] = useState(getCurrentPhase(caregiver));
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [editingTasks, setEditingTasks] = useState(false);
  const [taskDraft, setTaskDraft] = useState([]);
  const overallPct = getOverallProgress(caregiver);
  const greenLight = isGreenLight(caregiver);
  const days = getDaysSinceApplication(caregiver);
  const PHASE_TASKS = getPhaseTasks();

  const startEditing = () => {
    setEditForm({
      firstName: caregiver.firstName || '', lastName: caregiver.lastName || '',
      phone: caregiver.phone || '', email: caregiver.email || '',
      address: caregiver.address || '', city: caregiver.city || '',
      state: caregiver.state || '', zip: caregiver.zip || '',
      perId: caregiver.perId || '', hcaExpiration: caregiver.hcaExpiration || '',
      hasHCA: caregiver.hasHCA || 'yes', hasDL: caregiver.hasDL || 'yes',
      availability: caregiver.availability || '', source: caregiver.source || '',
      applicationDate: caregiver.applicationDate || '', initialNotes: caregiver.initialNotes || '',
    });
    setEditing(true);
  };

  const saveEdits = () => { onUpdateCaregiver(caregiver.id, editForm); setEditing(false); };
  const editField = (field, value) => { setEditForm((f) => ({ ...f, [field]: value })); };
  const handleAddNote = () => { if (!noteText.trim()) return; onAddNote(caregiver.id, noteText.trim()); setNoteText(''); };

  return (
    <div>
      {/* Header */}
      <div style={styles.detailHeader}>
        <button style={styles.backBtn} onClick={onBack}>← Back</button>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={styles.detailAvatar}>{caregiver.firstName?.[0]}{caregiver.lastName?.[0]}</div>
            <div>
              <h1 style={styles.detailName}>{caregiver.firstName} {caregiver.lastName}</h1>
              <div style={styles.detailMeta}>
                {caregiver.phone && <span>📞 {caregiver.phone}</span>}
                {caregiver.email && <span style={{ marginLeft: 16 }}>✉️ {caregiver.email}</span>}
                {caregiver.perId && <span style={{ marginLeft: 16 }}>🆔 PER {caregiver.perId}</span>}
              </div>
              {(caregiver.address || caregiver.city) && (
                <div style={{ ...styles.detailMeta, marginTop: 2 }}>
                  📍 {[caregiver.address, caregiver.city, caregiver.state, caregiver.zip].filter(Boolean).join(', ')}
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {greenLight && <span style={styles.greenLightBadgeLg}>🟢 Green Light</span>}
          <button style={styles.greenLightBtn} onClick={() => setShowGreenLight(!showGreenLight)}>🛡️ Green Light Check</button>
          <button style={styles.dangerBtn} onClick={() => setShowDeleteConfirm(true)}>🗑️</button>
        </div>
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div style={styles.alertCard}>
          <strong>Remove this caregiver?</strong> This action cannot be undone.
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button style={styles.dangerBtn} onClick={() => onDelete(caregiver.id)}>Yes, Remove</button>
            <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Green Light Checklist */}
      {showGreenLight && (
        <div style={styles.greenLightCard}>
          <h3 style={{ margin: '0 0 12px', color: '#1A1A1A', fontFamily: "'Outfit', sans-serif" }}>🛡️ Green Light Checklist</h3>
          <p style={{ margin: '0 0 16px', color: '#556270', fontSize: 13 }}>ALL items must be complete before scheduling Sunday Orientation.</p>
          {GREEN_LIGHT_ITEMS.map((item, i) => {
            const taskKeys = [
              ['offer_signed'],
              ['i9_form', 'w4_form', 'emergency_contact', 'employment_agreement'],
              ['background_check', 'hca_cleared'],
              ['tb_test'],
              ['training_assigned'],
            ];
            const done = taskKeys[i].every((k) => caregiver.tasks?.[k]);
            return (
              <div key={i} style={styles.greenLightRow}>
                <span style={{ color: done ? '#5BA88B' : '#D4697A', fontSize: 18 }}>{done ? '✓' : '✗'}</span>
                <span style={{ color: done ? '#5BA88B' : '#6B7B8F' }}>{item}</span>
              </div>
            );
          })}
          <button style={{ ...styles.secondaryBtn, marginTop: 12 }} onClick={() => setShowGreenLight(false)}>Close</button>
        </div>
      )}

      {/* Profile Information */}
      <div style={styles.profileCard}>
        <div style={styles.profileCardHeader}>
          <h3 style={styles.profileCardTitle}>👤 Profile Information</h3>
          {!editing ? (
            <button style={styles.editBtn} onClick={startEditing}>✏️ Edit</button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="tc-btn-primary" style={styles.primaryBtn} onClick={saveEdits}>Save</button>
              <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          )}
        </div>

        {!editing ? (
          <>
            <div style={styles.profileGrid}>
              {[
                { label: 'Full Name', value: `${caregiver.firstName} ${caregiver.lastName}` },
                { label: 'Phone', value: caregiver.phone },
                { label: 'Email', value: caregiver.email },
                { label: 'Address', value: (caregiver.address || caregiver.city) ? [caregiver.address, caregiver.city, caregiver.state, caregiver.zip].filter(Boolean).join(', ') : null },
                { label: 'HCA PER ID', value: caregiver.perId },
                { label: 'HCA Expiration Date', value: caregiver.hcaExpiration ? (() => { const exp = new Date(caregiver.hcaExpiration + 'T00:00:00'); const du = Math.ceil((exp - new Date()) / 86400000); const ds = exp.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); if (du < 0) return `⚠️ Expired — ${ds}`; if (du <= 30) return `⏰ ${ds} (${du} days)`; if (du <= 90) return `📅 ${ds} (${du} days)`; return `✅ ${ds}`; })() : null },
                { label: 'HCA Status', value: caregiver.hasHCA === 'yes' ? '✅ Valid HCA ID' : caregiver.hasHCA === 'willing' ? '📝 Willing to register' : '❌ No HCA ID' },
                { label: "Driver's License & Car", value: caregiver.hasDL === 'yes' ? '✅ Yes' : '❌ No' },
                { label: 'Availability', value: caregiver.availability },
                { label: 'Source', value: caregiver.source },
                { label: 'Application Date', value: caregiver.applicationDate ? new Date(caregiver.applicationDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null },
                { label: 'Days Since Application', value: `${days} day${days !== 1 ? 's' : ''}` },
                { label: 'Board Status', value: caregiver.boardStatus ? caregiver.boardStatus.charAt(0).toUpperCase() + caregiver.boardStatus.slice(1) : 'Not yet on board' },
                { label: 'Phase Override', value: caregiver.phaseOverride ? (() => { const p = PHASES.find((ph) => ph.id === caregiver.phaseOverride); return `⚙️ ${p?.icon} ${p?.label} (manual)`; })() : 'Auto (based on tasks)' },
              ].map((item) => (
                <div key={item.label} style={styles.profileItem}>
                  <div style={styles.profileLabel}>{item.label}</div>
                  <div style={styles.profileValue}>{item.value || '—'}</div>
                </div>
              ))}
            </div>
            {caregiver.initialNotes && (
              <div style={{ padding: '0 20px 16px' }}>
                <div style={styles.profileLabel}>Initial Notes</div>
                <div style={{ ...styles.profileValue, marginTop: 4 }}>{caregiver.initialNotes}</div>
              </div>
            )}
          </>
        ) : (
          <div style={{ padding: '16px 20px' }}>
            <div style={styles.formGrid}>
              <EditField label="First Name" value={editForm.firstName} onChange={(v) => editField('firstName', v)} />
              <EditField label="Last Name" value={editForm.lastName} onChange={(v) => editField('lastName', v)} />
              <EditField label="Phone" value={editForm.phone} onChange={(v) => editField('phone', v)} />
              <EditField label="Email" value={editForm.email} onChange={(v) => editField('email', v)} />
              <EditField label="Street Address" value={editForm.address} onChange={(v) => editField('address', v)} />
              <EditField label="City" value={editForm.city} onChange={(v) => editField('city', v)} />
              <EditField label="State" value={editForm.state} onChange={(v) => editField('state', v)} />
              <EditField label="Zip Code" value={editForm.zip} onChange={(v) => editField('zip', v)} />
              <EditField label="HCA PER ID" value={editForm.perId} onChange={(v) => editField('perId', v)} />
              <EditField label="HCA Expiration Date" value={editForm.hcaExpiration} onChange={(v) => editField('hcaExpiration', v)} type="date" />
              <div style={styles.field}>
                <label style={styles.fieldLabel}>HCA Status</label>
                <select style={styles.fieldInput} value={editForm.hasHCA} onChange={(e) => editField('hasHCA', e.target.value)}>
                  <option value="yes">Valid HCA ID</option><option value="no">No HCA ID</option><option value="willing">Willing to register</option>
                </select>
              </div>
              <div style={styles.field}>
                <label style={styles.fieldLabel}>Driver's License & Car</label>
                <select style={styles.fieldInput} value={editForm.hasDL} onChange={(e) => editField('hasDL', e.target.value)}>
                  <option value="yes">Yes</option><option value="no">No</option>
                </select>
              </div>
              <EditField label="Availability" value={editForm.availability} onChange={(v) => editField('availability', v)} />
              <div style={styles.field}>
                <label style={styles.fieldLabel}>Source</label>
                <select style={styles.fieldInput} value={editForm.source} onChange={(e) => editField('source', e.target.value)}>
                  <option>Indeed</option><option>Website</option><option>Referral</option><option>Other</option>
                </select>
              </div>
              <EditField label="Application Date" value={editForm.applicationDate} onChange={(v) => editField('applicationDate', v)} type="date" />
            </div>
            <div style={{ marginTop: 16 }}>
              <label style={styles.fieldLabel}>Initial Notes</label>
              <textarea style={styles.textarea} rows={3} value={editForm.initialNotes} onChange={(e) => editField('initialNotes', e.target.value)} />
            </div>
          </div>
        )}
      </div>

      {/* Progress Overview */}
      <div style={styles.progressOverview}>
        <div style={styles.progressHeader}>
          <span style={styles.progressTitle}>Onboarding Progress</span>
          <span style={styles.progressPct}>{overallPct}%</span>
          <span style={styles.progressDays}>Day {days}</span>
        </div>
        <div style={styles.progressTrack}>
          <div className="tc-progress-fill" style={{ ...styles.progressFill, width: `${overallPct}%` }} />
        </div>

        {/* Phase Override */}
        {(() => {
          const calculated = getCalculatedPhase(caregiver);
          const isOverridden = !!caregiver.phaseOverride;
          const currentPhase = getCurrentPhase(caregiver);
          const currentPhaseInfo = PHASES.find((p) => p.id === currentPhase);
          return (
            <div style={styles.phaseOverrideRow}>
              <div style={styles.phaseOverrideLeft}>
                <span style={styles.phaseOverrideLabel}>Current Phase:</span>
                <span style={{ ...styles.phaseBadge, background: `${currentPhaseInfo.color}18`, color: currentPhaseInfo.color, border: `1px solid ${currentPhaseInfo.color}30` }}>
                  {currentPhaseInfo.icon} {currentPhaseInfo.label}
                </span>
                {isOverridden && <span style={styles.overrideBadge}>⚙️ Manual Override</span>}
              </div>
              <div style={styles.phaseOverrideRight}>
                <select style={styles.phaseOverrideSelect} value={caregiver.phaseOverride || ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '') { onUpdateCaregiver(caregiver.id, { phaseOverride: null }); }
                    else {
                      onUpdateCaregiver(caregiver.id, { phaseOverride: val, phaseTimestamps: { ...caregiver.phaseTimestamps, [val]: caregiver.phaseTimestamps?.[val] || Date.now() } });
                      setActivePhase(val);
                    }
                  }}
                >
                  <option value="">Auto (based on tasks)</option>
                  {PHASES.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.label}{p.id === calculated ? ' ← calculated' : ''}</option>)}
                </select>
              </div>
            </div>
          );
        })()}

        <div style={styles.phaseNav}>
          {PHASES.map((p) => {
            const { pct } = getPhaseProgress(caregiver, p.id);
            return (
              <button key={p.id} style={{ ...styles.phaseTab, ...(activePhase === p.id ? { background: `${p.color}18`, borderColor: p.color, color: p.color } : {}) }} onClick={() => setActivePhase(p.id)}>
                <span>{p.icon}</span>
                <span style={styles.phaseTabLabel}>{p.short}</span>
                <span style={styles.phaseTabPct}>{pct}%</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Active Phase Detail */}
      <div style={styles.phaseDetail}>
        <div style={styles.phaseDetailHeader}>
          <div>
            <h2 style={styles.phaseDetailTitle}>{PHASES.find((p) => p.id === activePhase)?.icon} {PHASES.find((p) => p.id === activePhase)?.label}</h2>
            <p style={styles.phaseDetailSub}>{PHASES.find((p) => p.id === activePhase)?.description}</p>
          </div>
          {CHASE_SCRIPTS[activePhase] && (
            <button style={styles.scriptBtn} onClick={() => setShowScripts(showScripts === activePhase ? null : activePhase)}>
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
        {(() => {
          const phaseTasks = PHASE_TASKS[activePhase];
          const allDone = phaseTasks.every((t) => caregiver.tasks?.[t.id]);
          const noneDone = phaseTasks.every((t) => !caregiver.tasks?.[t.id]);
          return (
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
          );
        })()}

        {/* Task list */}
        {!editingTasks ? (
          <div style={styles.taskList}>
            {PHASE_TASKS[activePhase].map((task) => {
              const done = !!caregiver.tasks?.[task.id];
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

      {/* Notes Section */}
      <div style={styles.notesSection}>
        <h3 style={styles.notesSectionTitle}>📝 Activity Notes</h3>
        <div style={styles.noteInputRow}>
          <input style={styles.noteInput} placeholder="Add a note (e.g., called, left VM, sent docs)..." value={noteText} onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleAddNote()} />
          <button className="tc-btn-primary" style={styles.primaryBtn} onClick={handleAddNote}>Add</button>
        </div>
        <div style={styles.notesList}>
          {(caregiver.notes || []).slice().reverse().map((n, i) => (
            <div key={i} style={styles.noteItem}>
              <div style={styles.noteTimestamp}>{new Date(n.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
              <div style={styles.noteText}>{n.text}</div>
            </div>
          ))}
          {(!caregiver.notes || caregiver.notes.length === 0) && (
            <div style={{ color: '#6B7B8F', fontSize: 13, padding: 16, textAlign: 'center' }}>No notes yet. Track your outreach and communications here.</div>
          )}
        </div>
      </div>
    </div>
  );
}
