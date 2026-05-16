import { useState, useEffect, useCallback, useMemo } from 'react';
import btn from '../styles/buttons.module.css';
import forms from '../styles/forms.module.css';
import { CollapsibleCard } from '../shared/components/CollapsibleCard';
import {
  CALL_TAXONOMY_AXES,
  listCallTaxonomy,
  upsertCallTaxonomyRow,
  archiveCallTaxonomyRow,
  unarchiveCallTaxonomyRow,
  slugifyLabel,
} from '../lib/callTaxonomy';

// ═════════════════════════════════════════════════════════════
// CallTaxonomySettings (Phase 1.6.1)
//
// Admin UI for managing the `call_taxonomy` table. Two sections,
// one per axis (call_type / red_flag). Same visual idiom as
// MessageTemplateSettings + ActionItemRuleSettings.
//
// Per the locked owner directives in docs/AGENT_PLATFORM.md §
// "Owner directives locked", the taxonomy is data — operators can
// add / edit / archive freely. The Phase 1.6.2 `call_analyst` agent
// reads active rows of each axis at prompt-build time, so changes
// here propagate without a deploy.
// ═════════════════════════════════════════════════════════════

const AXIS_META = {
  call_type: {
    title:       'Call types',
    description: 'How the call_analyst classifies a transcript. The agent picks exactly one from this list.',
    newLabel:    '+ Add call type',
  },
  red_flag: {
    title:       'Red-flag categories',
    description: 'Risks the call_analyst surfaces to operators when detected in a transcript. The agent can tag multiple per call.',
    newLabel:    '+ Add red flag',
  },
};

export function CallTaxonomySettings({ showToast }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archivingId, setArchivingId] = useState(null);

  // Form state. `axisForForm` decides which section we're adding to;
  // `editingRow` is non-null when editing instead of adding.
  const [axisForForm, setAxisForForm] = useState('call_type');
  const [editingRow, setEditingRow] = useState(null);
  const [formSlug, setFormSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [formLabel, setFormLabel] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formSortOrder, setFormSortOrder] = useState(0);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // ─── Load ───
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listCallTaxonomy();
      setRows(data);
    } catch (err) {
      console.error('[CallTaxonomySettings] Failed to load taxonomy:', err);
      showToast?.('Failed to load call taxonomy', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  // ─── Partition rows by axis + active state ───
  const rowsByAxis = useMemo(() => {
    const out = { call_type: [], red_flag: [] };
    for (const r of rows) {
      if (!CALL_TAXONOMY_AXES.includes(r.axis)) continue;
      out[r.axis].push(r);
    }
    return out;
  }, [rows]);

  const archivedCount = useMemo(() => rows.filter((r) => !r.is_active).length, [rows]);

  // ─── Form helpers ───
  const openNew = (axis) => {
    setEditingRow(null);
    setAxisForForm(axis);
    setFormSlug('');
    setSlugManuallyEdited(false);
    setFormLabel('');
    setFormDescription('');
    // Default sort_order = next-after-max in this axis.
    const maxSort = rowsByAxis[axis].reduce((acc, r) => Math.max(acc, r.sort_order || 0), 0);
    setFormSortOrder(maxSort + 10);
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (row) => {
    setEditingRow(row);
    setAxisForForm(row.axis);
    setFormSlug(row.slug);
    setSlugManuallyEdited(true); // existing slug is locked in
    setFormLabel(row.label);
    setFormDescription(row.description || '');
    setFormSortOrder(row.sort_order ?? 0);
    setFormError('');
    setShowForm(true);
  };

  const closeForm = () => {
    if (saving) return;
    setShowForm(false);
  };

  const handleLabelChange = (next) => {
    setFormLabel(next);
    // Auto-derive the slug as the admin types the label, until they
    // manually edit the slug field. Locked once they touch the slug
    // input or once we're editing an existing row.
    if (!editingRow && !slugManuallyEdited) {
      setFormSlug(slugifyLabel(next));
    }
  };

  const handleSlugChange = (next) => {
    setSlugManuallyEdited(true);
    setFormSlug(next);
  };

  const handleSave = async () => {
    setFormError('');
    const trimmedSlug  = formSlug.trim();
    const trimmedLabel = formLabel.trim();
    if (!trimmedSlug)  { setFormError('Slug is required.'); return; }
    if (!trimmedLabel) { setFormError('Label is required.'); return; }
    if (!/^[a-z0-9_]+$/.test(trimmedSlug)) {
      setFormError('Slug can only contain lowercase letters, numbers, and underscores.');
      return;
    }
    setSaving(true);
    try {
      await upsertCallTaxonomyRow({
        axis:        axisForForm,
        slug:        trimmedSlug,
        label:       trimmedLabel,
        description: formDescription.trim() || null,
        sortOrder:   Number.isFinite(Number(formSortOrder)) ? Number(formSortOrder) : 0,
        isActive:    editingRow ? editingRow.is_active : true,
      });
      showToast?.(editingRow ? 'Taxonomy row updated' : 'Taxonomy row added');
      setShowForm(false);
      await load();
    } catch (err) {
      console.error('[CallTaxonomySettings] Save failed:', err);
      const msg = err?.message || 'Failed to save taxonomy row.';
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (row) => {
    if (!window.confirm(`Archive "${row.label}"? The call_analyst will stop using it. You can restore it later.`)) return;
    setArchivingId(row.id);
    try {
      await archiveCallTaxonomyRow(row);
      showToast?.('Taxonomy row archived');
      await load();
    } catch (err) {
      console.error('[CallTaxonomySettings] Archive failed:', err);
      showToast?.('Failed to archive taxonomy row', 'error');
    } finally {
      setArchivingId(null);
    }
  };

  const handleUnarchive = async (row) => {
    setArchivingId(row.id);
    try {
      await unarchiveCallTaxonomyRow(row);
      showToast?.('Taxonomy row restored');
      await load();
    } catch (err) {
      console.error('[CallTaxonomySettings] Unarchive failed:', err);
      showToast?.('Failed to restore taxonomy row', 'error');
    } finally {
      setArchivingId(null);
    }
  };

  // ═════════════════════════════════════════════════════════════
  // Render
  // ═════════════════════════════════════════════════════════════

  return (
    <CollapsibleCard
      title="Call Taxonomy"
      description="Categories the AI uses when analysing call transcripts"
    >
      <div style={{ padding: '16px 20px 20px' }}>
        <p style={{ fontSize: 13, color: '#4A5568', margin: '0 0 14px' }}>
          The future call-analysis agent uses these categories to classify transcripts and surface
          red flags. Edits take effect on the next call processed — no deploy needed. Archived rows
          stay reserved (their slug can't be reused).
        </p>

        {archivedCount > 0 && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#4A5568', marginBottom: 12, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived ({archivedCount})
          </label>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', color: '#7A8BA0', padding: '30px 0', fontSize: 14 }}>
            Loading taxonomy...
          </div>
        ) : (
          CALL_TAXONOMY_AXES.map((axis) => {
            const meta    = AXIS_META[axis];
            const allRows = rowsByAxis[axis];
            const visibleRows = allRows.filter((r) => showArchived || r.is_active);
            return (
              <div key={axis} style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div>
                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1F2937' }}>{meta.title}</h4>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6B7280' }}>{meta.description}</p>
                  </div>
                  <button
                    className={btn.primaryBtn}
                    onClick={() => openNew(axis)}
                    style={{ fontSize: 12, padding: '6px 12px' }}
                  >
                    {meta.newLabel}
                  </button>
                </div>
                {visibleRows.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#7A8BA0', padding: '20px 0', fontSize: 13, border: '1px dashed #E2E8F0', borderRadius: 8 }}>
                    No {meta.title.toLowerCase()} yet.
                  </div>
                ) : (
                  <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}>
                    {visibleRows.map((row, idx) => (
                      <div
                        key={row.id}
                        style={{
                          display:       'flex',
                          alignItems:    'center',
                          gap:           12,
                          padding:       '10px 14px',
                          borderBottom:  idx < visibleRows.length - 1 ? '1px solid #E2E8F0' : 'none',
                          background:    row.is_active ? '#FFFFFF' : '#F8FAFC',
                          opacity:       row.is_active ? 1 : 0.65,
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#1F2937' }}>
                            {row.label}
                            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: '#6B7280', fontFamily: 'monospace' }}>
                              {row.slug}
                            </span>
                            {!row.is_active && (
                              <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#F1F5F9', color: '#64748B' }}>
                                archived
                              </span>
                            )}
                          </div>
                          {row.description && (
                            <div style={{ fontSize: 12, color: '#4A5568', marginTop: 2 }}>{row.description}</div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className={btn.secondaryBtn}
                            onClick={() => openEdit(row)}
                            style={{ fontSize: 12, padding: '4px 10px' }}
                          >
                            Edit
                          </button>
                          {row.is_active ? (
                            <button
                              className={btn.secondaryBtn}
                              onClick={() => handleArchive(row)}
                              disabled={archivingId === row.id}
                              style={{ fontSize: 12, padding: '4px 10px' }}
                            >
                              {archivingId === row.id ? 'Archiving…' : 'Archive'}
                            </button>
                          ) : (
                            <button
                              className={btn.secondaryBtn}
                              onClick={() => handleUnarchive(row)}
                              disabled={archivingId === row.id}
                              style={{ fontSize: 12, padding: '4px 10px' }}
                            >
                              {archivingId === row.id ? 'Restoring…' : 'Restore'}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ─── Form modal ─── */}
      {showForm && (
        <div
          onClick={closeForm}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#FFFFFF', borderRadius: 12, padding: 20, width: 520, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto' }}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600 }}>
              {editingRow ? 'Edit taxonomy row' : `Add ${AXIS_META[axisForForm].title.slice(0, -1)}`}
            </h3>
            <div style={{ display: 'grid', gap: 10 }}>
              <div>
                <label className={forms.formLabel}>Label</label>
                <input
                  className={forms.formInput}
                  value={formLabel}
                  onChange={(e) => handleLabelChange(e.target.value)}
                  placeholder="e.g. Recruiting"
                  autoFocus
                />
              </div>
              <div>
                <label className={forms.formLabel}>Slug</label>
                <input
                  className={forms.formInput}
                  value={formSlug}
                  onChange={(e) => handleSlugChange(e.target.value)}
                  placeholder="lowercase_with_underscores"
                  disabled={!!editingRow}
                  style={{ fontFamily: 'monospace' }}
                />
                {!editingRow && (
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
                    Used by the agent prompt — can't be changed after creation.
                  </div>
                )}
              </div>
              <div>
                <label className={forms.formLabel}>Description (optional)</label>
                <textarea
                  className={forms.formTextarea}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="When should the agent apply this category?"
                  rows={3}
                />
              </div>
              <div>
                <label className={forms.formLabel}>Sort order</label>
                <input
                  className={forms.formInput}
                  type="number"
                  value={formSortOrder}
                  onChange={(e) => setFormSortOrder(e.target.value)}
                />
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
                  Lower numbers appear higher in the list. Use gaps (10, 20, 30) so new rows can slot in.
                </div>
              </div>
              {formError && (
                <div style={{ fontSize: 12, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 6, padding: '6px 10px' }}>
                  {formError}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button className={btn.secondaryBtn} onClick={closeForm} disabled={saving}>Cancel</button>
              <button className={btn.primaryBtn} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : editingRow ? 'Save changes' : 'Add row'}
              </button>
            </div>
          </div>
        </div>
      )}
    </CollapsibleCard>
  );
}
