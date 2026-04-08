import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBoards } from '../../shared/context/BoardContext';
import { DEFAULT_BOARD_COLUMNS, DEFAULT_BOARD_LABELS } from '../../lib/constants';
import btn from '../../styles/buttons.module.css';
import forms from '../../styles/forms.module.css';
import layout from '../../styles/layout.module.css';

const BOARD_TEMPLATES = [
  {
    id: 'caregiver',
    name: 'Caregiver Board',
    icon: '👥',
    description: 'Track deployed caregivers across assignment stages',
    entityType: 'caregiver',
    columns: DEFAULT_BOARD_COLUMNS,
    labels: DEFAULT_BOARD_LABELS,
  },
  {
    id: 'client',
    name: 'Client Pipeline',
    icon: '🏠',
    description: 'Track clients through intake and matching stages',
    entityType: 'client',
    columns: [
      { id: 'intake', label: 'New Intake', icon: '📋', color: '#2E4E8D', description: 'New client inquiry received' },
      { id: 'assessment', label: 'Assessment', icon: '🔍', color: '#29BEE4', description: 'Needs assessment in progress' },
      { id: 'matching', label: 'Matching', icon: '🤝', color: '#D97706', description: 'Finding the right caregiver match' },
      { id: 'active', label: 'Active Service', icon: '✅', color: '#16A34A', description: 'Currently receiving care' },
    ],
    labels: [
      { id: 'urgent', name: 'Urgent', color: '#DC3545' },
      { id: 'high_hours', name: 'High Hours', color: '#D97706' },
      { id: 'live_in', name: 'Live-In', color: '#8B5CF6' },
      { id: 'new', name: 'New Client', color: '#29BEE4' },
    ],
  },
  {
    id: 'blank',
    name: 'Blank Board',
    icon: '📋',
    description: 'Start from scratch with empty columns',
    entityType: 'custom',
    columns: [],
    labels: [],
  },
];

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

export function BoardsIndex() {
  const navigate = useNavigate();
  const { boards, loaded, addBoard, removeBoard } = useBoards();
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '', template: 'caregiver' });
  const [confirmDelete, setConfirmDelete] = useState(null);

  const handleCreate = async () => {
    if (!createForm.name.trim()) return;
    const template = BOARD_TEMPLATES.find((t) => t.id === createForm.template) || BOARD_TEMPLATES[2];
    const board = await addBoard({
      name: createForm.name.trim(),
      slug: slugify(createForm.name.trim()) + '-' + Date.now().toString(36),
      description: createForm.description.trim() || template.description,
      entityType: template.entityType,
      columns: template.columns,
      labels: template.labels,
      checklistTemplates: [],
      orientationData: {},
    });
    setShowCreate(false);
    setCreateForm({ name: '', description: '', template: 'caregiver' });
    navigate(`/boards/${board.id}`);
  };

  const handleDelete = async (boardId) => {
    await removeBoard(boardId);
    setConfirmDelete(null);
  };

  if (!loaded) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: '#7A8BA0', fontSize: 15 }}>
        Loading boards...
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '0 24px' }}>
      <div className={layout.header}>
        <div>
          <h1 className={layout.pageTitle}>Boards</h1>
          <p className={layout.pageSubtitle}>Organize your team's work across multiple Kanban boards</p>
        </div>
        <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={() => setShowCreate(true)}>
          + New Board
        </button>
      </div>

      {/* Board Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 20,
        marginTop: 8,
      }}>
        {boards.map((board) => (
          <div
            key={board.id}
            onClick={() => navigate(`/boards/${board.id}`)}
            style={{
              background: '#fff',
              borderRadius: 12,
              border: '1px solid #E2E8F0',
              padding: 24,
              cursor: 'pointer',
              transition: 'all 0.15s',
              position: 'relative',
              boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = '#2E4E8D';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(46,78,141,0.12)';
              e.currentTarget.style.transform = 'translateY(-2px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = '#E2E8F0';
              e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.04)';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            {/* Color bar */}
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 4,
              borderRadius: '12px 12px 0 0',
              background: board.columns?.[0]?.color || '#2E4E8D',
            }} />

            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ fontSize: 17, fontWeight: 700, color: '#1A1A1A', margin: 0 }}>
                {board.name}
              </h3>
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(board.id); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#A0AEC0', fontSize: 16, padding: '0 4px',
                  borderRadius: 4, transition: 'color 0.15s',
                }}
                onMouseEnter={(e) => e.currentTarget.style.color = '#DC3545'}
                onMouseLeave={(e) => e.currentTarget.style.color = '#A0AEC0'}
                title="Delete board"
              >
                &#10005;
              </button>
            </div>

            {board.description && (
              <p style={{ fontSize: 13, color: '#556270', margin: '0 0 16px', lineHeight: 1.5 }}>
                {board.description}
              </p>
            )}

            {/* Column preview */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(board.columns || []).slice(0, 4).map((col) => (
                <span key={col.id} style={{
                  fontSize: 11, padding: '3px 8px', borderRadius: 4,
                  background: `${col.color}14`, color: col.color,
                  fontWeight: 600, whiteSpace: 'nowrap',
                }}>
                  {col.icon} {col.label}
                </span>
              ))}
              {(board.columns || []).length > 4 && (
                <span style={{ fontSize: 11, color: '#A0AEC0', alignSelf: 'center' }}>
                  +{board.columns.length - 4} more
                </span>
              )}
            </div>

            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, marginTop: 16,
              paddingTop: 12, borderTop: '1px solid #F1F5F9',
              fontSize: 12, color: '#8896A6',
            }}>
              <span style={{
                padding: '2px 8px', borderRadius: 4,
                background: board.entityType === 'caregiver' ? '#EFF6FF' : board.entityType === 'client' ? '#F0FDF4' : '#F5F3FF',
                color: board.entityType === 'caregiver' ? '#2E4E8D' : board.entityType === 'client' ? '#16A34A' : '#7C3AED',
                fontWeight: 600, fontSize: 11, textTransform: 'capitalize',
              }}>
                {board.entityType}
              </span>
              <span>{(board.columns || []).length} columns</span>
            </div>
          </div>
        ))}

        {/* Empty state / Create card */}
        {boards.length === 0 && (
          <div style={{
            gridColumn: '1 / -1',
            textAlign: 'center',
            padding: '60px 24px',
            color: '#7A8BA0',
          }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>📋</div>
            <h3 style={{ color: '#1A1A1A', marginBottom: 8 }}>No boards yet</h3>
            <p style={{ marginBottom: 20, fontSize: 14 }}>
              Create your first board to start organizing your team's work.
            </p>
            <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={() => setShowCreate(true)}>
              + Create Your First Board
            </button>
          </div>
        )}
      </div>

      {/* Create Board Modal */}
      {showCreate && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setShowCreate(false)}
        >
          <div
            style={{
              background: '#fff', borderRadius: 16, padding: 32, width: '90%', maxWidth: 520,
              boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ margin: '0 0 20px', fontSize: 20, fontWeight: 700, color: '#1A1A1A' }}>
              Create New Board
            </h2>

            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Board Name *</label>
              <input
                className={forms.fieldInput}
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g., Training Pipeline, Night Shift Pool"
                autoFocus
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Description</label>
              <input
                className={forms.fieldInput}
                value={createForm.description}
                onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Brief description of what this board tracks"
              />
            </div>

            <div style={{ marginBottom: 24 }}>
              <label className={forms.fieldLabel}>Start from template</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                {BOARD_TEMPLATES.map((tpl) => (
                  <label
                    key={tpl.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '12px 14px', borderRadius: 8, cursor: 'pointer',
                      border: createForm.template === tpl.id ? '2px solid #2E4E8D' : '2px solid #E2E8F0',
                      background: createForm.template === tpl.id ? '#F8FAFF' : '#fff',
                      transition: 'all 0.15s',
                    }}
                  >
                    <input
                      type="radio"
                      name="template"
                      checked={createForm.template === tpl.id}
                      onChange={() => setCreateForm((f) => ({ ...f, template: tpl.id }))}
                      style={{ display: 'none' }}
                    />
                    <span style={{ fontSize: 24 }}>{tpl.icon}</span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14, color: '#1A1A1A' }}>{tpl.name}</div>
                      <div style={{ fontSize: 12, color: '#6B7B8F' }}>{tpl.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className={`tc-btn-secondary ${btn.secondaryBtn}`} onClick={() => setShowCreate(false)}>Cancel</button>
              <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={handleCreate} disabled={!createForm.name.trim()}>
                Create Board
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDelete && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setConfirmDelete(null)}
        >
          <div
            style={{
              background: '#fff', borderRadius: 12, padding: 28, width: '90%', maxWidth: 400,
              boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: '#1A1A1A' }}>
              Delete "{boards.find((b) => b.id === confirmDelete)?.name}"?
            </h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: '#556270' }}>
              This will permanently delete this board and all its cards. This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className={`tc-btn-secondary ${btn.secondaryBtn}`} onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className={btn.dangerBtn} onClick={() => handleDelete(confirmDelete)}>Delete Board</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
