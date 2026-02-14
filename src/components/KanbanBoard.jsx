import { useState, useEffect, useRef } from 'react';
import { PHASES, DEFAULT_BOARD_COLUMNS, COLUMN_ICONS, COLUMN_COLORS } from '../lib/constants';
import { getCurrentPhase, getOverallProgress, getPhaseProgress } from '../lib/utils';
import { loadBoardColumns, saveBoardColumns } from '../lib/storage';
import kb from './KanbanBoard.module.css';
import btn from '../styles/buttons.module.css';
import forms from '../styles/forms.module.css';
import layout from '../styles/layout.module.css';

// ─── Fireworks celebration canvas ────────────────────────────
function Fireworks() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width = 340;
    const H = canvas.height = 120;
    const particles = [];
    const colors = ['#FFD700', '#FF6B6B', '#4ADE80', '#60A5FA', '#F472B6', '#FBBF24', '#A78BFA', '#34D399'];

    for (let burst = 0; burst < 5; burst++) {
      const cx = 40 + Math.random() * (W - 80);
      const cy = 20 + Math.random() * (H - 50);
      const count = 14 + Math.floor(Math.random() * 10);
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
        const speed = 1.2 + Math.random() * 2;
        particles.push({
          x: cx, y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          decay: 0.012 + Math.random() * 0.01,
          color: colors[Math.floor(Math.random() * colors.length)],
          size: 1.5 + Math.random() * 2,
        });
      }
    }

    let frame;
    const animate = () => {
      ctx.clearRect(0, 0, W, H);
      let alive = false;
      particles.forEach((p) => {
        if (p.life <= 0) return;
        alive = true;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.03;
        p.vx *= 0.99;
        p.life -= p.decay;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      if (alive) frame = requestAnimationFrame(animate);
    };
    animate();
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: 120, display: 'block', pointerEvents: 'none' }}
    />
  );
}

// ─── Orientation Banner ──────────────────────────────────────
// Exported so it can also be used from Dashboard if needed
export function OrientationBanner({ caregivers }) {
  const [orientationData, setOrientationData] = useState({});
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [loaded, setLoaded] = useState(false);

  // Use dynamic import to avoid circular deps — orientation storage
  useEffect(() => {
    import('../lib/storage').then(({ loadOrientationData }) => {
      loadOrientationData().then((data) => {
        setOrientationData(data);
        setLoaded(true);
      });
    });
  }, []);

  useEffect(() => {
    if (loaded) {
      import('../lib/storage').then(({ saveOrientationData }) => {
        saveOrientationData(orientationData);
      });
    }
  }, [orientationData, loaded]);

  const startEdit = () => { setEditForm({ ...orientationData }); setEditing(true); };
  const saveEdit = () => { setOrientationData(editForm); setEditing(false); };

  const inOrientation = caregivers.filter(
    (cg) => getCurrentPhase(cg) === 'orientation' && cg.tasks?.orientation_confirmed
  ).length;
  const goal = orientationData.goal || 5;
  const goalPct = Math.min(100, Math.round((inOrientation / goal) * 100));

  let countdown = null;
  let countdownUrgency = 'info';
  if (orientationData.date) {
    const orientDate = new Date(orientationData.date + 'T' + (orientationData.time || '09:00'));
    const diffMs = orientDate - new Date();
    const diffDays = Math.ceil(diffMs / 86400000);
    if (diffDays < 0) { countdown = 'Past due — set the next orientation date'; countdownUrgency = 'critical'; }
    else if (diffDays === 0) { countdown = 'TODAY'; countdownUrgency = 'critical'; }
    else if (diffDays === 1) { countdown = 'TOMORROW'; countdownUrgency = 'warning'; }
    else if (diffDays <= 3) { countdown = `${diffDays} days away`; countdownUrgency = 'warning'; }
    else { countdown = `${diffDays} days away`; }
  }

  if (!orientationData.date && !editing) {
    return (
      <div className={kb.banner}>
        <div className={kb.noDate}>
          <div className={kb.noDateTitle}>No Orientation Scheduled</div>
          <div className={kb.noDateSub}>Set the next orientation date so your team knows the target.</div>
          <button className={kb.editBtnWhite} onClick={startEdit}>+ Set Orientation Date</button>
        </div>
      </div>
    );
  }

  return (
    <div className={kb.banner}>
      {!editing ? (
        <>
          <div className={kb.bannerTop}>
            <div>
              <div className={kb.bannerLabel}>Next Orientation</div>
              <div className={kb.bannerDate}>
                {new Date(orientationData.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </div>
              {orientationData.time && (
                <div className={kb.bannerTime}>
                  {new Date('2000-01-01T' + orientationData.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </div>
              )}
              {orientationData.location && <div className={kb.bannerLocation}>{orientationData.location}</div>}
              <button className={kb.editBtnWhite} onClick={startEdit}>Edit</button>
            </div>
            <div className={kb.countdownBox}>
              <div className={kb.countdownValue} style={{
                color: countdownUrgency === 'critical' ? '#FFD3CC' : countdownUrgency === 'warning' ? '#FFF0CC' : '#fff',
              }}>
                {countdown}
              </div>
              <div className={kb.countdownSub}>until orientation</div>
            </div>
          </div>
          <div className={kb.bannerBottom}>
            <span className={kb.goalLabel}>{goalPct >= 100 ? 'Goal Met!' : 'Attendee Goal'}</span>
            <div className={kb.goalTrack}>
              <div className={kb.goalFill} style={{
                width: `${goalPct}%`,
                background: goalPct >= 100 ? '#4ADE80' : goalPct >= 60 ? '#FCD34D' : '#FB923C',
              }} />
            </div>
            <span className={kb.goalCount}>{inOrientation} / {goal}</span>
          </div>
          {goalPct >= 100 && <Fireworks />}
        </>
      ) : (
        <div className={kb.editOverlay}>
          <div className={kb.bannerLabelEdit}>Orientation Settings</div>
          <div className={kb.editGrid}>
            <div>
              <div className={kb.editLabel}>Date *</div>
              <input className={kb.editInput} type="date" value={editForm.date || ''} onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div>
              <div className={kb.editLabel}>Time</div>
              <input className={kb.editInput} type="time" value={editForm.time || ''} onChange={(e) => setEditForm((f) => ({ ...f, time: e.target.value }))} />
            </div>
            <div>
              <div className={kb.editLabel}>Location</div>
              <input className={kb.editInput} type="text" placeholder="e.g., Main Office, Zoom" value={editForm.location || ''} onChange={(e) => setEditForm((f) => ({ ...f, location: e.target.value }))} />
            </div>
            <div>
              <div className={kb.editLabel}>Attendee Goal</div>
              <input className={kb.editInput} type="number" min="1" value={editForm.goal || 5} onChange={(e) => setEditForm((f) => ({ ...f, goal: parseInt(e.target.value) || 1 }))} />
            </div>
          </div>
          <div className={kb.editActions}>
            <button className={kb.cancelBtnWhite} onClick={() => setEditing(false)}>Cancel</button>
            <button className={kb.saveBtnWhite} onClick={saveEdit}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ═══ KANBAN BOARD ════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════

export function KanbanBoard({ caregivers, onUpdateStatus, onUpdateNote, onAddNote, onSelect }) {
  const [dragId, setDragId] = useState(null);
  const [editingNote, setEditingNote] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [columns, setColumns] = useState(DEFAULT_BOARD_COLUMNS);
  const [colsLoaded, setColsLoaded] = useState(false);
  const [showAddCol, setShowAddCol] = useState(false);
  const [editingCol, setEditingCol] = useState(null);
  const [colForm, setColForm] = useState({ label: '', icon: '', color: '#2E4E8D', description: '' });
  const [dragColId, setDragColId] = useState(null);
  const [confirmDeleteCol, setConfirmDeleteCol] = useState(null);
  const [modalCgId, setModalCgId] = useState(null);
  const [modalNote, setModalNote] = useState('');

  useEffect(() => {
    loadBoardColumns().then((cols) => { setColumns(cols); setColsLoaded(true); });
  }, []);

  useEffect(() => {
    if (colsLoaded) saveBoardColumns(columns);
  }, [columns, colsLoaded]);

  const boardCaregivers = caregivers.filter(
    (cg) => cg.boardStatus || getOverallProgress(cg) === 100
  );
  const unassigned = boardCaregivers.filter(
    (cg) => !cg.boardStatus || !columns.find((c) => c.id === cg.boardStatus)
  );
  const getColumnCaregivers = (colId) => boardCaregivers.filter((cg) => cg.boardStatus === colId);

  const handleDrop = (colId) => {
    if (dragId) { onUpdateStatus(dragId, colId); setDragId(null); }
  };

  const handleColDrop = (targetColId) => {
    if (!dragColId || dragColId === targetColId) return;
    setColumns((prev) => {
      const cols = [...prev];
      const fromIdx = cols.findIndex((c) => c.id === dragColId);
      const toIdx = cols.findIndex((c) => c.id === targetColId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = cols.splice(fromIdx, 1);
      cols.splice(toIdx, 0, moved);
      return cols;
    });
    setDragColId(null);
  };

  const addColumn = () => {
    if (!colForm.label.trim()) return;
    setColumns((prev) => [...prev, {
      id: 'col_' + Date.now().toString(36),
      label: colForm.label.trim(), icon: colForm.icon, color: colForm.color, description: colForm.description.trim(),
    }]);
    setColForm({ label: '', icon: '', color: '#2E4E8D', description: '' });
    setShowAddCol(false);
  };

  const saveEditColumn = () => {
    if (!colForm.label.trim()) return;
    setColumns((prev) => prev.map((c) =>
      c.id === editingCol ? { ...c, label: colForm.label.trim(), icon: colForm.icon, color: colForm.color, description: colForm.description.trim() } : c
    ));
    setEditingCol(null);
    setColForm({ label: '', icon: '', color: '#2E4E8D', description: '' });
  };

  const deleteColumn = (colId) => {
    getColumnCaregivers(colId).forEach((cg) => onUpdateStatus(cg.id, ''));
    setColumns((prev) => prev.filter((c) => c.id !== colId));
    setConfirmDeleteCol(null);
  };

  const startEditColumn = (col) => {
    setEditingCol(col.id);
    setColForm({ label: col.label, icon: col.icon, color: col.color, description: col.description || '' });
    setShowAddCol(false);
  };

  const moveColumn = (colId, direction) => {
    setColumns((prev) => {
      const cols = [...prev];
      const idx = cols.findIndex((c) => c.id === colId);
      if (idx === -1) return prev;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= cols.length) return prev;
      [cols[idx], cols[newIdx]] = [cols[newIdx], cols[idx]];
      return cols;
    });
  };

  const renderColumnForm = (isEdit) => (
    <div className={kb.colFormOverlay} onClick={() => { setShowAddCol(false); setEditingCol(null); }}>
      <div className={kb.colFormModal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: '#1A1A1A' }}>
          {isEdit ? 'Edit Column' : 'Add New Column'}
        </h3>
        <div style={{ marginBottom: 12 }}>
          <label className={forms.fieldLabel}>Column Name *</label>
          <input className={forms.fieldInput} value={colForm.label} onChange={(e) => setColForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g., On Hold, Night Shift Pool" autoFocus />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label className={forms.fieldLabel}>Description</label>
          <input className={forms.fieldInput} value={colForm.description} onChange={(e) => setColForm((f) => ({ ...f, description: e.target.value }))} placeholder="Brief description" />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label className={forms.fieldLabel}>Icon</label>
          <div className={kb.iconPicker}>
            {COLUMN_ICONS.map((icon) => (
              <button key={icon} className={kb.iconOption} style={colForm.icon === icon ? { background: '#2E4E8D', color: '#fff', border: '2px solid #2E4E8D' } : {}} onClick={() => setColForm((f) => ({ ...f, icon }))}>{icon}</button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <label className={forms.fieldLabel}>Color</label>
          <div className={kb.colorPicker}>
            {COLUMN_COLORS.map((color) => (
              <button key={color} className={kb.colorOption} style={{ background: color, ...(colForm.color === color ? { outline: '3px solid #1A1A1A', outlineOffset: 2 } : {}) }} onClick={() => setColForm((f) => ({ ...f, color }))} />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className={`tc-btn-secondary ${btn.secondaryBtn}`} onClick={() => { setShowAddCol(false); setEditingCol(null); }}>Cancel</button>
          <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={isEdit ? saveEditColumn : addColumn}>{isEdit ? 'Save Changes' : 'Add Column'}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <div className={layout.header}>
        <div>
          <h1 className={layout.pageTitle}>Caregiver Board</h1>
          <p className={layout.pageSubtitle}>Manage deployed caregivers — drag cards between columns or use the move menu</p>
        </div>
        <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={() => { setColForm({ label: '', icon: '', color: '#2E4E8D', description: '' }); setShowAddCol(true); setEditingCol(null); }}>
          + Add Column
        </button>
      </div>

      {showAddCol && renderColumnForm(false)}
      {editingCol && renderColumnForm(true)}

      {/* Delete confirmation */}
      {confirmDeleteCol && (
        <div className={kb.colFormOverlay} onClick={() => setConfirmDeleteCol(null)}>
          <div className={kb.colFormModal} style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: '#1A1A1A' }}>
              Delete "{columns.find((c) => c.id === confirmDeleteCol)?.label}"?
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#556270' }}>
              {getColumnCaregivers(confirmDeleteCol).length > 0
                ? `${getColumnCaregivers(confirmDeleteCol).length} caregiver(s) will be moved to unassigned.`
                : 'This column is empty.'}{' '}This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className={`tc-btn-secondary ${btn.secondaryBtn}`} onClick={() => setConfirmDeleteCol(null)}>Cancel</button>
              <button className={btn.dangerBtn} onClick={() => deleteColumn(confirmDeleteCol)}>Delete Column</button>
            </div>
          </div>
        </div>
      )}

      {/* Unassigned banner */}
      {unassigned.length > 0 && (
        <div className={kb.unassignedBanner}>
          <div className={kb.unassignedTitle}>{unassigned.length} caregiver{unassigned.length > 1 ? 's' : ''} ready to assign</div>
          <div className={kb.unassignedDesc}>Assign them to a column to start tracking their deployment status.</div>
          <div className={kb.unassignedCards}>
            {unassigned.map((cg) => (
              <div key={cg.id} className={kb.unassignedCard}>
                <div className={kb.unassignedCardName}>{cg.firstName} {cg.lastName}</div>
                <div className={kb.unassignedCardActions}>
                  {columns.map((col) => (
                    <button key={col.id} className={kb.assignBtn} style={{ background: `${col.color}12`, color: col.color, border: `1px solid ${col.color}30` }} onClick={() => onUpdateStatus(cg.id, col.id)} title={col.label}>{col.icon}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Kanban Columns */}
      <div className={kb.columnsContainer} style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(240px, 1fr))` }}>
        {columns.map((col, colIdx) => {
          const colCaregivers = getColumnCaregivers(col.id);
          return (
            <div key={col.id} className={kb.column} style={dragColId === col.id ? { opacity: 0.5 } : {}}
              onDragOver={(e) => { e.preventDefault(); if (dragColId) e.dataTransfer.dropEffect = 'move'; }}
              onDrop={() => { if (dragColId) handleColDrop(col.id); else handleDrop(col.id); }}
            >
              <div className={kb.columnHeaderBar} style={{ background: col.color }} draggable
                onDragStart={(e) => { setDragColId(col.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDragColId(null)}
              >
                <span className={kb.columnGrip}></span>
                <span className={kb.columnTitleWhite}>{col.icon} {col.label}</span>
                <span className={kb.columnCountWhite}>{colCaregivers.length}</span>
              </div>
              <div className={kb.columnActions}>
                {colIdx > 0 && <button className={kb.colActionBtn} onClick={() => moveColumn(col.id, -1)} title="Move left">&larr;</button>}
                {colIdx < columns.length - 1 && <button className={kb.colActionBtn} onClick={() => moveColumn(col.id, 1)} title="Move right">&rarr;</button>}
                <button className={kb.colActionBtn} onClick={() => startEditColumn(col)} title="Edit column">Edit</button>
                <button className={kb.colActionBtn} style={{ color: '#DC3545' }} onClick={() => setConfirmDeleteCol(col.id)} title="Delete column">Del</button>
              </div>
              {col.description && <div className={kb.columnDesc}>{col.description}</div>}

              <div className={kb.columnBody}>
                {colCaregivers.length === 0 ? (
                  <div className={kb.columnEmpty}>Drop caregivers here</div>
                ) : (
                  colCaregivers.map((cg) => (
                    <div key={cg.id} draggable
                      onDragStart={() => { setDragId(cg.id); setDragColId(null); }}
                      onDragEnd={() => setDragId(null)}
                      className={kb.card} style={{ ...(dragId === cg.id ? { opacity: 0.4 } : {}), borderLeft: `3px solid ${col.color}` }}
                    >
                      <div className={kb.cardTop}>
                        <div className={kb.cardName} onClick={() => setModalCgId(cg.id)}>{cg.firstName} {cg.lastName}</div>
                        <div className={kb.cardMoveMenu}>
                          <select className={kb.cardMoveSelect} value={cg.boardStatus} onChange={(e) => onUpdateStatus(cg.id, e.target.value)}>
                            {columns.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className={kb.cardDetails}>
                        {cg.phone && <span className={kb.cardDetail}>{cg.phone}</span>}
                        {cg.availability && <span className={kb.cardDetail}>{cg.availability}</span>}
                      </div>
                      {cg.boardMovedAt && (
                        <div className={kb.cardMoved}>
                          Moved here {new Date(cg.boardMovedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </div>
                      )}
                      {editingNote === cg.id ? (
                        <div className={kb.cardNoteEdit}>
                          <input className={kb.cardNoteInput} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note..."
                            onKeyDown={(e) => { if (e.key === 'Enter') { onUpdateNote(cg.id, noteText); setEditingNote(null); setNoteText(''); } if (e.key === 'Escape') { setEditingNote(null); setNoteText(''); } }} autoFocus />
                          <button className={kb.cardNoteSave} onClick={() => { onUpdateNote(cg.id, noteText); setEditingNote(null); setNoteText(''); }}>&#10003;</button>
                        </div>
                      ) : (
                        <div className={kb.cardNote} onClick={() => { setEditingNote(cg.id); setNoteText(cg.boardNote || ''); }}>
                          {cg.boardNote || <span style={{ color: '#A0AEC0', fontStyle: 'italic' }}>+ Add note...</span>}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Card Detail Modal */}
      {modalCgId && (() => {
        const cg = caregivers.find((c) => c.id === modalCgId);
        if (!cg) return null;
        const currentCol = columns.find((c) => c.id === cg.boardStatus);
        const progress = getOverallProgress(cg);

        return (
          <div className={kb.colFormOverlay} onClick={() => { setModalCgId(null); setModalNote(''); }}>
            <div className={kb.modalContainer} onClick={(e) => e.stopPropagation()}>
              <div className={kb.modalHeader}>
                <div className={kb.modalAvatar}>{cg.firstName?.[0]}{cg.lastName?.[0]}</div>
                <div style={{ flex: 1 }}>
                  <div className={kb.modalName}>{cg.firstName} {cg.lastName}</div>
                  {currentCol && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                      <span className={kb.modalStatusDot} style={{ background: currentCol.color }} />
                      <span className={kb.modalStatusLabel}>{currentCol.icon} {currentCol.label}</span>
                    </div>
                  )}
                </div>
                <button className={kb.modalCloseBtn} onClick={() => { setModalCgId(null); setModalNote(''); }}>&#10005;</button>
              </div>

              <div className={kb.modalBody}>
                <div className={kb.modalSection}>
                  <div className={kb.modalSectionTitle}>Contact & Details</div>
                  <div className={kb.modalInfoGrid}>
                    {[
                      { icon: 'Phone', label: 'Phone', value: cg.phone },
                      { icon: 'Email', label: 'Email', value: cg.email },
                      { icon: 'Address', label: 'Address', value: (cg.address || cg.city) ? [cg.address, cg.city, cg.state, cg.zip].filter(Boolean).join(', ') : null },
                      { icon: 'Avail', label: 'Availability', value: cg.availability },
                      { icon: 'ID', label: 'HCA PER ID', value: cg.perId },
                    ].map((item) => (
                      <div key={item.label} className={kb.modalInfoItem}>
                        <span className={kb.modalInfoIcon}>{item.icon === 'Phone' ? '\u260E' : item.icon === 'Email' ? '\u2709' : item.icon === 'Address' ? '\uD83D\uDCCD' : item.icon === 'Avail' ? '\uD83D\uDD50' : '\uD83C\uDD94'}</span>
                        <div>
                          <div className={kb.modalInfoLabel}>{item.label}</div>
                          <div className={kb.modalInfoValue}>{item.value || '\u2014'}</div>
                        </div>
                      </div>
                    ))}
                    <div className={kb.modalInfoItem}>
                      <span className={kb.modalInfoIcon}>{'\uD83D\uDCC5'}</span>
                      <div>
                        <div className={kb.modalInfoLabel}>HCA Expiration</div>
                        <div className={kb.modalInfoValue}>
                          {cg.hcaExpiration ? (() => {
                            const exp = new Date(cg.hcaExpiration + 'T00:00:00');
                            const daysUntil = Math.ceil((exp - new Date()) / 86400000);
                            const dateStr = exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                            if (daysUntil < 0) return <span style={{ color: '#DC3545' }}>Expired</span>;
                            if (daysUntil <= 30) return <span style={{ color: '#D97706' }}>{dateStr} ({daysUntil}d)</span>;
                            return dateStr;
                          })() : '\u2014'}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className={kb.modalSection}>
                  <div className={kb.modalSectionTitle}>Onboarding Progress</div>
                  <div className={kb.modalProgressRow}>
                    <div className={kb.modalProgressTrack}>
                      <div className={kb.modalProgressFill} style={{ width: `${progress}%` }} />
                    </div>
                    <span className={kb.modalProgressPct}>{progress}%</span>
                  </div>
                  <div className={kb.modalProgressMeta}>
                    {PHASES.map((p) => {
                      const { pct } = getPhaseProgress(cg, p.id);
                      return <span key={p.id} className={kb.modalPhasePill} style={{ color: pct === 100 ? '#16A34A' : '#6B7B8F' }}>{pct === 100 ? '\u2713 ' : ''}{p.icon} {p.short}</span>;
                    })}
                  </div>
                </div>

                <div className={kb.modalSection}>
                  <div className={kb.modalSectionTitle}>Move to Column</div>
                  <div className={kb.modalMoveRow}>
                    {columns.map((c) => (
                      <button key={c.id} className={kb.modalMoveBtn} style={cg.boardStatus === c.id ? { background: c.color, color: '#fff', border: `2px solid ${c.color}` } : { border: `2px solid ${c.color}30`, color: c.color }} onClick={() => onUpdateStatus(cg.id, c.id)}>
                        {c.icon} {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={kb.modalSection}>
                  <div className={kb.modalSectionTitle}>Board Note</div>
                  <textarea className={kb.modalNoteTextarea} rows={2} placeholder="Add a note about deployment status..." value={cg.boardNote || ''} onChange={(e) => onUpdateNote(cg.id, e.target.value)} />
                </div>

                <div className={kb.modalSection}>
                  <div className={kb.modalSectionTitle}>Activity Notes</div>
                  <div className={kb.modalActivityInput}>
                    <input className={kb.modalActivityField} placeholder="Add a note..." value={modalNote} onChange={(e) => setModalNote(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && modalNote.trim()) { onAddNote(cg.id, modalNote.trim()); setModalNote(''); } }} />
                    <button className={kb.modalActivityBtn} onClick={() => { if (modalNote.trim()) { onAddNote(cg.id, modalNote.trim()); setModalNote(''); } }}>Add</button>
                  </div>
                  <div className={kb.modalNotesList}>
                    {(cg.notes || []).slice().reverse().slice(0, 5).map((n, i) => (
                      <div key={i} className={kb.modalNoteItem}>
                        <span className={kb.modalNoteTime}>{new Date(n.timestamp || n.date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                        <span className={kb.modalNoteText}>{n.text}</span>
                      </div>
                    ))}
                    {(!cg.notes || cg.notes.length === 0) && <div style={{ color: '#A0AEC0', fontSize: 12, padding: '8px 0', fontStyle: 'italic' }}>No activity notes yet.</div>}
                  </div>
                </div>
              </div>

              <div className={kb.modalFooter}>
                <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={() => { setModalCgId(null); setModalNote(''); onSelect(cg.id); }}>
                  Open Full Profile &rarr;
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
