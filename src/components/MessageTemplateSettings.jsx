import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import btn from '../styles/buttons.module.css';
import forms from '../styles/forms.module.css';
import { CollapsibleCard } from '../shared/components/CollapsibleCard';
import {
  MESSAGE_TEMPLATE_CATEGORIES,
  MESSAGE_TEMPLATE_CATEGORY_LABELS,
  CAREGIVER_TEMPLATE_PLACEHOLDERS,
  listAllTemplates,
  createTemplate,
  updateTemplate,
  archiveTemplate,
  unarchiveTemplate,
  validateTemplateDraft,
  renderCaregiverTemplate,
} from '../features/caregivers/caregiver/messageTemplateHelpers';

// Sample caregiver used for the live preview so admins see realistic
// output as they edit. Not persisted — preview-only.
const PREVIEW_CAREGIVER = { firstName: 'Maria', lastName: 'Garcia' };

// ═════════════════════════════════════════════════════════════
// MessageTemplateSettings
//
// Admin UI for managing the `message_templates` table. Mirrors the
// look and behavior of ActionItemRuleSettings / AutomationSettings
// so the Settings page stays visually coherent.
// ═════════════════════════════════════════════════════════════

export function MessageTemplateSettings({ showToast, currentUserEmail }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [archivingId, setArchivingId] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  // ─── Form state ───
  const [formName, setFormName] = useState('');
  const [formCategory, setFormCategory] = useState('general');
  const [formBody, setFormBody] = useState('');
  const [formError, setFormError] = useState('');
  const bodyRef = useRef(null);

  // ─── Load ───
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listAllTemplates();
      setTemplates(data);
    } catch (err) {
      console.error('[MessageTemplateSettings] Failed to load templates:', err);
      showToast?.('Failed to load templates', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  // ─── Filtered list ───
  const visibleTemplates = useMemo(
    () => templates.filter((t) => showArchived || !t.is_archived),
    [templates, showArchived],
  );

  const activeCount = useMemo(
    () => templates.filter((t) => !t.is_archived).length,
    [templates],
  );
  const archivedCount = templates.length - activeCount;

  // ─── Form helpers ───
  const openNew = () => {
    setEditingTemplate(null);
    setFormName('');
    setFormCategory('general');
    setFormBody('');
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (template) => {
    setEditingTemplate(template);
    setFormName(template.name);
    setFormCategory(template.category);
    setFormBody(template.body);
    setFormError('');
    setShowForm(true);
  };

  const closeForm = () => {
    if (saving) return;
    setShowForm(false);
  };

  const insertPlaceholder = (key) => {
    const el = bodyRef.current;
    if (!el) {
      setFormBody((prev) => `${prev}{{${key}}}`);
      return;
    }
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    const tag = `{{${key}}}`;
    const next = formBody.substring(0, start) + tag + formBody.substring(end);
    setFormBody(next);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + tag.length, start + tag.length);
    }, 0);
  };

  const handleSave = async () => {
    const draft = { name: formName, category: formCategory, body: formBody };
    const validationError = validateTemplateDraft(draft);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      if (editingTemplate) {
        await updateTemplate(editingTemplate.id, {
          ...draft,
          updatedBy: currentUserEmail,
        });
        showToast?.('Template updated');
      } else {
        await createTemplate({ ...draft, createdBy: currentUserEmail });
        showToast?.('Template created');
      }
      setShowForm(false);
      await load();
    } catch (err) {
      // Supabase returns a friendly-ish `message`; surface it inline.
      // Unique-name collisions surface here (code 23505).
      const msg = err?.message || 'Failed to save template.';
      if (err?.code === '23505' || /duplicate|unique/i.test(msg)) {
        setFormError('A template with that name already exists. Pick a different name.');
      } else {
        setFormError(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (template) => {
    if (!window.confirm(`Archive "${template.name}"? Staff will no longer see it in the composer. You can restore it from the archived list.`)) {
      return;
    }
    setArchivingId(template.id);
    try {
      await archiveTemplate(template.id, currentUserEmail);
      showToast?.('Template archived');
      await load();
    } catch (err) {
      console.error('[MessageTemplateSettings] Archive failed:', err);
      showToast?.('Failed to archive template', 'error');
    } finally {
      setArchivingId(null);
    }
  };

  const handleUnarchive = async (template) => {
    setArchivingId(template.id);
    try {
      await unarchiveTemplate(template.id, currentUserEmail);
      showToast?.('Template restored');
      await load();
    } catch (err) {
      console.error('[MessageTemplateSettings] Unarchive failed:', err);
      const msg = err?.message || '';
      if (err?.code === '23505' || /duplicate|unique/i.test(msg)) {
        showToast?.('Another active template has the same name — rename it first.', 'error');
      } else {
        showToast?.('Failed to restore template', 'error');
      }
    } finally {
      setArchivingId(null);
    }
  };

  // ─── Preview (live) ───
  const previewText = useMemo(
    () => renderCaregiverTemplate(formBody, PREVIEW_CAREGIVER),
    [formBody],
  );

  const bodyCharCount = formBody.length;

  // ═════════════════════════════════════════════════════════════
  // Render
  // ═════════════════════════════════════════════════════════════

  return (
    <CollapsibleCard
      title="Message Templates"
      description="Reusable SMS"
      headerRight={
        <button
          className={btn.primaryBtn}
          onClick={(e) => { e.stopPropagation(); openNew(); }}
          style={{ fontSize: 13, padding: '6px 14px' }}
        >
          + New Template
        </button>
      }
    >
      <div style={{ padding: '16px 20px 20px' }}>
        <p style={{ fontSize: 13, color: '#4A5568', margin: '0 0 14px' }}>
          Admin-managed SMS templates that staff can insert from the caregiver
          messaging composer. Use <code style={{ background: '#F1F5F9', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>{'{{firstName}}'}</code>,{' '}
          <code style={{ background: '#F1F5F9', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>{'{{lastName}}'}</code>, or{' '}
          <code style={{ background: '#F1F5F9', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>{'{{fullName}}'}</code>{' '}
          to personalize — they fill in with the caregiver's details at send time.
        </p>

        {/* Toggle archived */}
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

        {/* List */}
        {loading ? (
          <div style={{ textAlign: 'center', color: '#7A8BA0', padding: '30px 0', fontSize: 14 }}>
            Loading templates...
          </div>
        ) : visibleTemplates.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#7A8BA0', padding: '30px 0', fontSize: 14 }}>
            {activeCount === 0
              ? 'No templates yet. Click "+ New Template" to create one.'
              : 'No archived templates to show.'}
          </div>
        ) : (
          <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 120px 160px',
              gap: 8, padding: '10px 14px', background: '#F8F9FB',
              borderBottom: '1px solid #E2E8F0', fontSize: 11, fontWeight: 600,
              color: '#7A8BA0', textTransform: 'uppercase',
            }}>
              <span>Template</span>
              <span>Category</span>
              <span></span>
            </div>
            {visibleTemplates.map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 120px 160px',
                  gap: 8, padding: '10px 14px', borderBottom: '1px solid #F0F0F0',
                  alignItems: 'center', fontSize: 13,
                  opacity: t.is_archived ? 0.6 : 1,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {t.name}
                    {t.is_archived && (
                      <span style={{
                        padding: '1px 6px', fontSize: 10, borderRadius: 4,
                        background: '#F1F5F9', color: '#64748B', fontWeight: 600,
                      }}>archived</span>
                    )}
                  </div>
                  <div style={{
                    fontSize: 12, color: '#7A8BA0', marginTop: 2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {t.body}
                  </div>
                </div>
                <CategoryBadge category={t.category} />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button
                    className={btn.secondaryBtn}
                    onClick={() => openEdit(t)}
                    style={{ fontSize: 12, padding: '4px 10px' }}
                  >
                    Edit
                  </button>
                  {t.is_archived ? (
                    <button
                      onClick={() => handleUnarchive(t)}
                      disabled={archivingId === t.id}
                      style={{
                        fontSize: 12, padding: '4px 10px', background: '#F0FDF4',
                        color: '#15803D', border: '1px solid #BBF7D0',
                        borderRadius: 6, cursor: archivingId === t.id ? 'wait' : 'pointer',
                      }}
                    >
                      Restore
                    </button>
                  ) : (
                    <button
                      onClick={() => handleArchive(t)}
                      disabled={archivingId === t.id}
                      style={{
                        fontSize: 12, padding: '4px 10px', background: '#FEF2F2',
                        color: '#DC3545', border: '1px solid #FECACA',
                        borderRadius: 6, cursor: archivingId === t.id ? 'wait' : 'pointer',
                      }}
                    >
                      Archive
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Form Modal ─── */}
      {showForm && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(2px)',
          }}
          onClick={closeForm}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 12, padding: 28, width: '100%',
              maxWidth: 580, maxHeight: '90vh', overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
          >
            <h3 style={{ margin: '0 0 20px', fontSize: 18, fontWeight: 700 }}>
              {editingTemplate ? 'Edit Template' : 'New Message Template'}
            </h3>

            {/* Name */}
            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Name</label>
              <input
                className={forms.fieldInput}
                value={formName}
                onChange={(e) => { setFormName(e.target.value); setFormError(''); }}
                placeholder="e.g., Interview Reminder"
                maxLength={80}
              />
            </div>

            {/* Category */}
            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Category</label>
              <select
                className={forms.fieldInput}
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value)}
              >
                {MESSAGE_TEMPLATE_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {MESSAGE_TEMPLATE_CATEGORY_LABELS[cat]}
                  </option>
                ))}
              </select>
            </div>

            {/* Body */}
            <div style={{ marginBottom: 8 }}>
              <label className={forms.fieldLabel}>Message</label>
              <textarea
                ref={bodyRef}
                className={forms.textarea || forms.fieldInput}
                value={formBody}
                onChange={(e) => { setFormBody(e.target.value); setFormError(''); }}
                rows={5}
                placeholder="Hi {{firstName}}, ..."
                style={{ resize: 'vertical', fontFamily: 'inherit' }}
              />
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 11, color: '#7A8BA0', marginTop: 4,
              }}>
                <span>Click a placeholder to insert at the cursor:</span>
                <span style={{ color: bodyCharCount > 1600 ? '#DC3545' : '#7A8BA0' }}>
                  {bodyCharCount}/1600
                </span>
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                {CAREGIVER_TEMPLATE_PLACEHOLDERS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => insertPlaceholder(p.key)}
                    style={{
                      padding: '3px 8px', fontSize: 11, borderRadius: 4,
                      border: '1px solid #DDE2E8', background: '#F8F9FB',
                      color: '#4A5568', cursor: 'pointer',
                    }}
                    title={`Insert ${p.label}`}
                  >
                    {`{{${p.key}}}`}
                  </button>
                ))}
              </div>
            </div>

            {/* Preview */}
            <div style={{ marginTop: 16, marginBottom: 16 }}>
              <div style={{
                fontSize: 10, fontWeight: 700, color: '#7A8BA0',
                textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6,
              }}>
                Preview (for Maria Garcia)
              </div>
              <div style={{
                background: '#F0F8FF', border: '1px solid #BFDBFE',
                borderRadius: 8, padding: '12px 14px', fontSize: 13,
                color: '#1E3A8A', whiteSpace: 'pre-wrap', minHeight: 40,
              }}>
                {previewText || <span style={{ color: '#94A3B8', fontStyle: 'italic' }}>Preview will appear here</span>}
              </div>
            </div>

            {/* Error */}
            {formError && (
              <div style={{ color: '#DC3545', fontSize: 13, marginBottom: 12 }}>
                {formError}
              </div>
            )}

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                className={btn.secondaryBtn}
                onClick={closeForm}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className={btn.primaryBtn}
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : editingTemplate ? 'Update Template' : 'Create Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </CollapsibleCard>
  );
}

// ─── Category Badge ─────────────────────────────────────────────

function CategoryBadge({ category }) {
  const colors = {
    onboarding: { bg: '#F0FDF4', text: '#15803D', border: '#BBF7D0' },
    scheduling: { bg: '#EFF6FF', text: '#1D4ED8', border: '#BFDBFE' },
    general: { bg: '#F5F3FF', text: '#6D28D9', border: '#DDD6FE' },
  };
  const c = colors[category] || { bg: '#F1F5F9', text: '#475569', border: '#E2E8F0' };
  return (
    <span style={{
      padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
      display: 'inline-block', textAlign: 'center',
    }}>
      {MESSAGE_TEMPLATE_CATEGORY_LABELS[category] || category}
    </span>
  );
}
