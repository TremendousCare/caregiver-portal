import { useState, useEffect, useRef } from 'react';
import { PHASES, DEFAULT_BOARD_COLUMNS, COLUMN_ICONS, COLUMN_COLORS } from '../lib/constants';
import { getCurrentPhase, getOverallProgress, getPhaseProgress } from '../lib/utils';
import { loadBoardColumns, saveBoardColumns } from '../lib/storage';
import { styles, boardStyles } from '../styles/theme';

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

  const orientStyles = {
    banner: {
      background: 'linear-gradient(135deg, #0EA5C9 0%, #2E4E8D 100%)',
      borderRadius: 12, padding: 0, marginBottom: 16, overflow: 'hidden', color: '#fff',
    },
    bannerTop: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
      padding: '18px 20px 14px', gap: 12, flexWrap: 'wrap',
    },
    bannerLabel: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.7, marginBottom: 4 },
    bannerDate: { fontSize: 22, fontWeight: 700, lineHeight: 1.2 },
    bannerTime: { fontSize: 13, opacity: 0.8, marginTop: 2 },
    bannerLocation: { fontSize: 12, opacity: 0.7, marginTop: 2 },
    countdownBox: { textAlign: 'right' },
    countdownValue: { fontSize: 20, fontWeight: 800, lineHeight: 1.2 },
    countdownSub: { fontSize: 11, opacity: 0.7, marginTop: 2 },
    editBtnWhite: {
      background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.3)',
      borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 600,
      color: '#fff', cursor: 'pointer', fontFamily: 'inherit', marginTop: 6,
    },
    bannerBottom: {
      background: 'rgba(0,0,0,0.15)', padding: '12px 20px',
      display: 'flex', alignItems: 'center', gap: 14,
    },
    goalLabel: { fontSize: 12, fontWeight: 600, flexShrink: 0 },
    goalTrack: { flex: 1, height: 8, background: 'rgba(255,255,255,0.2)', borderRadius: 4, overflow: 'hidden' },
    goalFill: { height: '100%', borderRadius: 4, transition: 'width 0.3s' },
    goalCount: { fontSize: 13, fontWeight: 700, flexShrink: 0 },
    noDate: { padding: 20, textAlign: 'center' },
    noDateTitle: { fontSize: 15, fontWeight: 600, marginBottom: 4 },
    noDateSub: { fontSize: 12, opacity: 0.7, marginBottom: 12 },
    editOverlay: { background: 'rgba(0,0,0,0.15)', padding: '16px 20px' },
    editGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 },
    editLabel: { fontSize: 11, fontWeight: 600, opacity: 0.8, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
    editInput: {
      width: '100%', padding: '7px 10px', border: '1px solid rgba(255,255,255,0.3)',
      borderRadius: 6, fontSize: 13, fontFamily: 'inherit', color: '#fff',
      background: 'rgba(255,255,255,0.1)', outline: 'none', boxSizing: 'border-box',
    },
    editActions: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
    saveBtnWhite: {
      background: '#fff', color: '#2E4E8D', border: 'none', borderRadius: 6,
      padding: '6px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    },
    cancelBtnWhite: {
      background: 'rgba(255,255,255,0.15)', color: '#fff',
      border: '1px solid rgba(255,255,255,0.3)', borderRadius: 6,
      padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    },
  };

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
      <div style={orientStyles.banner}>
        <div style={orientStyles.noDate}>
          <div style={orientStyles.noDateTitle}>🎓 No Orientation Scheduled</div>
          <div style={orientStyles.noDateSub}>Set the next orientation date so your team knows the target.</div>
          <button style={orientStyles.editBtnWhite} onClick={startEdit}>+ Set Orientation Date</button>
        </div>
      </div>
    );
  }

  return (
    <div style={orientStyles.banner}>
      {!editing ? (
        <>
          <div style={orientStyles.bannerTop}>
            <div>
              <div style={orientStyles.bannerLabel}>Next Orientation</div>
              <div style={orientStyles.bannerDate}>
                {new Date(orientationData.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </div>
              {orientationData.time && (
                <div style={orientStyles.bannerTime}>
                  ⏰ {new Date('2000-01-01T' + orientationData.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </div>
              )}
              {orientationData.location && <div style={orientStyles.bannerLocation}>📍 {orientationData.location}</div>}
              <button style={orientStyles.editBtnWhite} onClick={startEdit}>✏️ Edit</button>
            </div>
            <div style={orientStyles.countdownBox}>
              <div style={{
                ...orientStyles.countdownValue,
                color: countdownUrgency === 'critical' ? '#FFD3CC' : countdownUrgency === 'warning' ? '#FFF0CC' : '#fff',
              }}>
                {countdown}
              </div>
              <div style={orientStyles.countdownSub}>until orientation</div>
            </div>
          </div>
          <div style={orientStyles.bannerBottom}>
            <span style={orientStyles.goalLabel}>{goalPct >= 100 ? '🎉 Goal Met!' : 'Attendee Goal'}</span>
            <div style={orientStyles.goalTrack}>
              <div style={{
                ...orientStyles.goalFill,
                width: `${goalPct}%`,
                background: goalPct >= 100 ? '#4ADE80' : goalPct >= 60 ? '#FCD34D' : '#FB923C',
              }} />
            </div>
            <span style={orientStyles.goalCount}>{inOrientation} / {goal}</span>
          </div>
          {goalPct >= 100 && <Fireworks />}
        </>
      ) : (
        <div style={orientStyles.editOverlay}>
          <div style={{ ...orientStyles.bannerLabel, marginBottom: 12 }}>Orientation Settings</div>
          <div style={orientStyles.editGrid}>
            <div>
              <div style={orientStyles.editLabel}>Date *</div>
              <input style={orientStyles.editInput} type="date" value={editForm.date || ''} onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div>
              <div style={orientStyles.editLabel}>Time</div>
              <input style={orientStyles.editInput} type="time" value={editForm.time || ''} onChange={(e) => setEditForm((f) => ({ ...f, time: e.target.value }))} />
            </div>
            <div>
              <div style={orientStyles.editLabel}>Location</div>
              <input style={orientStyles.editInput} type="text" placeholder="e.g., Main Office, Zoom" value={editForm.location || ''} onChange={(e) => setEditForm((f) => ({ ...f, location: e.target.value }))} />
            </div>
            <div>
              <div style={orientStyles.editLabel}>Attendee Goal</div>
              <input style={orientStyles.editInput} type="number" min="1" value={editForm.goal || 5} onChange={(e) => setEditForm((f) => ({ ...f, goal: parseInt(e.target.value) || 1 }))} />
            </div>
          </div>
          <div style={orientStyles.editActions}>
            <button style={orientStyles.cancelBtnWhite} onClick={() => setEditing(false)}>Cancel</button>
            <button style={orientStyles.saveBtnWhite} onClick={saveEdit}>Save</button>
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
  const [colForm, setColForm] = useState({ label: '', icon: '📋', color: '#2E4E8D', description: '' });
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
    setColForm({ label: '', icon: '📋', color: '#2E4E8D', description: '' });
    setShowAddCol(false);
  };

  const saveEditColumn = () => {
    if (!colForm.label.trim()) return;
    setColumns((prev) => prev.map((c) =>
      c.id === editingCol ? { ...c, label: colForm.label.trim(), icon: colForm.icon, color: colForm.color, description: colForm.description.trim() } : c
    ));
    setEditingCol(null);
    setColForm({ label: '', icon: '📋', color: '#2E4E8D', description: '' });
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
    <div style={boardStyles.colFormOverlay} onClick={() => { setShowAddCol(false); setEditingCol(null); }}>
      <div style={boardStyles.colFormModal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: '#1A1A1A' }}>
          {isEdit ? 'Edit Column' : 'Add New Column'}
        </h3>
        <div style={{ marginBottom: 12 }}>
          <label style={styles.fieldLabel}>Column Name *</label>
          <input style={styles.fieldInput} value={colForm.label} onChange={(e) => setColForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g., On Hold, Night Shift Pool" autoFocus />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={styles.fieldLabel}>Description</label>
          <input style={styles.fieldInput} value={colForm.description} onChange={(e) => setColForm((f) => ({ ...f, description: e.target.value }))} placeholder="Brief description" />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={styles.fieldLabel}>Icon</label>
          <div style={boardStyles.iconPicker}>
            {COLUMN_ICONS.map((icon) => (
              <button key={icon} style={{ ...boardStyles.iconOption, ...(colForm.icon === icon ? { background: '#2E4E8D', color: '#fff', border: '2px solid #2E4E8D' } : {}) }} onClick={() => setColForm((f) => ({ ...f, icon }))}>{icon}</button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={styles.fieldLabel}>Color</label>
          <div style={boardStyles.colorPicker}>
            {COLUMN_COLORS.map((color) => (
              <button key={color} style={{ ...boardStyles.colorOption, background: color, ...(colForm.color === color ? { outline: '3px solid #1A1A1A', outlineOffset: 2 } : {}) }} onClick={() => setColForm((f) => ({ ...f, color }))} />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={() => { setShowAddCol(false); setEditingCol(null); }}>Cancel</button>
          <button className="tc-btn-primary" style={styles.primaryBtn} onClick={isEdit ? saveEditColumn : addColumn}>{isEdit ? 'Save Changes' : 'Add Column'}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>Caregiver Board</h1>
          <p style={styles.pageSubtitle}>Manage deployed caregivers — drag cards between columns or use the move menu</p>
        </div>
        <button className="tc-btn-primary" style={styles.primaryBtn} onClick={() => { setColForm({ label: '', icon: '📋', color: '#2E4E8D', description: '' }); setShowAddCol(true); setEditingCol(null); }}>
          ＋ Add Column
        </button>
      </div>

      {showAddCol && renderColumnForm(false)}
      {editingCol && renderColumnForm(true)}

      {/* Delete confirmation */}
      {confirmDeleteCol && (
        <div style={boardStyles.colFormOverlay} onClick={() => setConfirmDeleteCol(null)}>
          <div style={{ ...boardStyles.colFormModal, maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: '#1A1A1A' }}>
              Delete "{columns.find((c) => c.id === confirmDeleteCol)?.label}"?
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#556270' }}>
              {getColumnCaregivers(confirmDeleteCol).length > 0
                ? `${getColumnCaregivers(confirmDeleteCol).length} caregiver(s) will be moved to unassigned.`
                : 'This column is empty.'}{' '}This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={() => setConfirmDeleteCol(null)}>Cancel</button>
              <button style={styles.dangerBtn} onClick={() => deleteColumn(confirmDeleteCol)}>Delete Column</button>
            </div>
          </div>
        </div>
      )}

      {/* Unassigned banner */}
      {unassigned.length > 0 && (
        <div style={boardStyles.unassignedBanner}>
          <div style={boardStyles.unassignedTitle}>🎓 {unassigned.length} caregiver{unassigned.length > 1 ? 's' : ''} ready to assign</div>
          <div style={boardStyles.unassignedDesc}>Assign them to a column to start tracking their deployment status.</div>
          <div style={boardStyles.unassignedCards}>
            {unassigned.map((cg) => (
              <div key={cg.id} style={boardStyles.unassignedCard}>
                <div style={boardStyles.unassignedCardName}>{cg.firstName} {cg.lastName}</div>
                <div style={boardStyles.unassignedCardActions}>
                  {columns.map((col) => (
                    <button key={col.id} style={{ ...boardStyles.assignBtn, background: `${col.color}12`, color: col.color, border: `1px solid ${col.color}30` }} onClick={() => onUpdateStatus(cg.id, col.id)} title={col.label}>{col.icon}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Kanban Columns */}
      <div style={{ ...boardStyles.columnsContainer, gridTemplateColumns: `repeat(${columns.length}, minmax(240px, 1fr))` }}>
        {columns.map((col, colIdx) => {
          const colCaregivers = getColumnCaregivers(col.id);
          return (
            <div key={col.id} style={{ ...boardStyles.column, ...(dragColId === col.id ? { opacity: 0.5 } : {}) }}
              onDragOver={(e) => { e.preventDefault(); if (dragColId) e.dataTransfer.dropEffect = 'move'; }}
              onDrop={() => { if (dragColId) handleColDrop(col.id); else handleDrop(col.id); }}
            >
              <div style={{ ...boardStyles.columnHeaderBar, background: col.color }} draggable
                onDragStart={(e) => { setDragColId(col.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDragColId(null)}
              >
                <span style={boardStyles.columnGrip}>⠿</span>
                <span style={boardStyles.columnTitleWhite}>{col.icon} {col.label}</span>
                <span style={boardStyles.columnCountWhite}>{colCaregivers.length}</span>
              </div>
              <div style={boardStyles.columnActions}>
                {colIdx > 0 && <button style={boardStyles.colActionBtn} onClick={() => moveColumn(col.id, -1)} title="Move left">←</button>}
                {colIdx < columns.length - 1 && <button style={boardStyles.colActionBtn} onClick={() => moveColumn(col.id, 1)} title="Move right">→</button>}
                <button style={boardStyles.colActionBtn} onClick={() => startEditColumn(col)} title="Edit column">✏️</button>
                <button style={{ ...boardStyles.colActionBtn, color: '#DC3545' }} onClick={() => setConfirmDeleteCol(col.id)} title="Delete column">🗑️</button>
              </div>
              {col.description && <div style={boardStyles.columnDesc}>{col.description}</div>}

              <div style={boardStyles.columnBody}>
                {colCaregivers.length === 0 ? (
                  <div style={boardStyles.columnEmpty}>Drop caregivers here</div>
                ) : (
                  colCaregivers.map((cg) => (
                    <div key={cg.id} draggable
                      onDragStart={() => { setDragId(cg.id); setDragColId(null); }}
                      onDragEnd={() => setDragId(null)}
                      style={{ ...boardStyles.card, ...(dragId === cg.id ? { opacity: 0.4 } : {}), borderLeft: `3px solid ${col.color}` }}
                    >
                      <div style={boardStyles.cardTop}>
                        <div style={boardStyles.cardName} onClick={() => setModalCgId(cg.id)}>{cg.firstName} {cg.lastName}</div>
                        <div style={boardStyles.cardMoveMenu}>
                          <select style={boardStyles.cardMoveSelect} value={cg.boardStatus} onChange={(e) => onUpdateStatus(cg.id, e.target.value)}>
                            {columns.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div style={boardStyles.cardDetails}>
                        {cg.phone && <span style={boardStyles.cardDetail}>📞 {cg.phone}</span>}
                        {cg.availability && <span style={boardStyles.cardDetail}>🕐 {cg.availability}</span>}
                      </div>
                      {cg.boardMovedAt && (
                        <div style={boardStyles.cardMoved}>
                          Moved here {new Date(cg.boardMovedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </div>
                      )}
                      {editingNote === cg.id ? (
                        <div style={boardStyles.cardNoteEdit}>
                          <input style={boardStyles.cardNoteInput} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a note..."
                            onKeyDown={(e) => { if (e.key === 'Enter') { onUpdateNote(cg.id, noteText); setEditingNote(null); setNoteText(''); } if (e.key === 'Escape') { setEditingNote(null); setNoteText(''); } }} autoFocus />
                          <button style={boardStyles.cardNoteSave} onClick={() => { onUpdateNote(cg.id, noteText); setEditingNote(null); setNoteText(''); }}>✓</button>
                        </div>
                      ) : (
                        <div style={boardStyles.cardNote} onClick={() => { setEditingNote(cg.id); setNoteText(cg.boardNote || ''); }}>
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
          <div style={boardStyles.colFormOverlay} onClick={() => { setModalCgId(null); setModalNote(''); }}>
            <div style={boardStyles.modalContainer} onClick={(e) => e.stopPropagation()}>
              <div style={boardStyles.modalHeader}>
                <div style={boardStyles.modalAvatar}>{cg.firstName?.[0]}{cg.lastName?.[0]}</div>
                <div style={{ flex: 1 }}>
                  <div style={boardStyles.modalName}>{cg.firstName} {cg.lastName}</div>
                  {currentCol && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                      <span style={{ ...boardStyles.modalStatusDot, background: currentCol.color }} />
                      <span style={boardStyles.modalStatusLabel}>{currentCol.icon} {currentCol.label}</span>
                    </div>
                  )}
                </div>
                <button style={boardStyles.modalCloseBtn} onClick={() => { setModalCgId(null); setModalNote(''); }}>✕</button>
              </div>

              <div style={boardStyles.modalBody}>
                <div style={boardStyles.modalSection}>
                  <div style={boardStyles.modalSectionTitle}>Contact & Details</div>
                  <div style={boardStyles.modalInfoGrid}>
                    {[
                      { icon: '📞', label: 'Phone', value: cg.phone },
                      { icon: '✉️', label: 'Email', value: cg.email },
                      { icon: '📍', label: 'Address', value: (cg.address || cg.city) ? [cg.address, cg.city, cg.state, cg.zip].filter(Boolean).join(', ') : null },
                      { icon: '🕐', label: 'Availability', value: cg.availability },
                      { icon: '🆔', label: 'HCA PER ID', value: cg.perId },
                    ].map((item) => (
                      <div key={item.label} style={boardStyles.modalInfoItem}>
                        <span style={boardStyles.modalInfoIcon}>{item.icon}</span>
                        <div>
                          <div style={boardStyles.modalInfoLabel}>{item.label}</div>
                          <div style={boardStyles.modalInfoValue}>{item.value || '—'}</div>
                        </div>
                      </div>
                    ))}
                    <div style={boardStyles.modalInfoItem}>
                      <span style={boardStyles.modalInfoIcon}>📅</span>
                      <div>
                        <div style={boardStyles.modalInfoLabel}>HCA Expiration</div>
                        <div style={boardStyles.modalInfoValue}>
                          {cg.hcaExpiration ? (() => {
                            const exp = new Date(cg.hcaExpiration + 'T00:00:00');
                            const daysUntil = Math.ceil((exp - new Date()) / 86400000);
                            const dateStr = exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                            if (daysUntil < 0) return <span style={{ color: '#DC3545' }}>⚠️ Expired</span>;
                            if (daysUntil <= 30) return <span style={{ color: '#D97706' }}>{dateStr} ({daysUntil}d)</span>;
                            return dateStr;
                          })() : '—'}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div style={boardStyles.modalSection}>
                  <div style={boardStyles.modalSectionTitle}>Onboarding Progress</div>
                  <div style={boardStyles.modalProgressRow}>
                    <div style={boardStyles.modalProgressTrack}>
                      <div style={{ ...boardStyles.modalProgressFill, width: `${progress}%` }} />
                    </div>
                    <span style={boardStyles.modalProgressPct}>{progress}%</span>
                  </div>
                  <div style={boardStyles.modalProgressMeta}>
                    {PHASES.map((p) => {
                      const { pct } = getPhaseProgress(cg, p.id);
                      return <span key={p.id} style={{ ...boardStyles.modalPhasePill, color: pct === 100 ? '#16A34A' : '#6B7B8F' }}>{pct === 100 ? '✓ ' : ''}{p.icon} {p.short}</span>;
                    })}
                  </div>
                </div>

                <div style={boardStyles.modalSection}>
                  <div style={boardStyles.modalSectionTitle}>Move to Column</div>
                  <div style={boardStyles.modalMoveRow}>
                    {columns.map((c) => (
                      <button key={c.id} style={{ ...boardStyles.modalMoveBtn, ...(cg.boardStatus === c.id ? { background: c.color, color: '#fff', border: `2px solid ${c.color}` } : { border: `2px solid ${c.color}30`, color: c.color }) }} onClick={() => onUpdateStatus(cg.id, c.id)}>
                        {c.icon} {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={boardStyles.modalSection}>
                  <div style={boardStyles.modalSectionTitle}>Board Note</div>
                  <textarea style={boardStyles.modalNoteTextarea} rows={2} placeholder="Add a note about deployment status..." value={cg.boardNote || ''} onChange={(e) => onUpdateNote(cg.id, e.target.value)} />
                </div>

                <div style={boardStyles.modalSection}>
                  <div style={boardStyles.modalSectionTitle}>Activity Notes</div>
                  <div style={boardStyles.modalActivityInput}>
                    <input style={boardStyles.modalActivityField} placeholder="Add a note..." value={modalNote} onChange={(e) => setModalNote(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && modalNote.trim()) { onAddNote(cg.id, modalNote.trim()); setModalNote(''); } }} />
                    <button style={boardStyles.modalActivityBtn} onClick={() => { if (modalNote.trim()) { onAddNote(cg.id, modalNote.trim()); setModalNote(''); } }}>Add</button>
                  </div>
                  <div style={boardStyles.modalNotesList}>
                    {(cg.notes || []).slice().reverse().slice(0, 5).map((n, i) => (
                      <div key={i} style={boardStyles.modalNoteItem}>
                        <span style={boardStyles.modalNoteTime}>{new Date(n.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                        <span style={boardStyles.modalNoteText}>{n.text}</span>
                      </div>
                    ))}
                    {(!cg.notes || cg.notes.length === 0) && <div style={{ color: '#A0AEC0', fontSize: 12, padding: '8px 0', fontStyle: 'italic' }}>No activity notes yet.</div>}
                  </div>
                </div>
              </div>

              <div style={boardStyles.modalFooter}>
                <button className="tc-btn-primary" style={styles.primaryBtn} onClick={() => { setModalCgId(null); setModalNote(''); onSelect(cg.id); }}>
                  Open Full Profile →
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
