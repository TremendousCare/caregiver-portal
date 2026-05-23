// Follow-up template settings — toggle templates and edit their
// cadence/copy. Wired into AdminSettings as a CollapsibleCard.
//
// v1 scope (locked with the owner):
//   - Toggle enabled per template
//   - Edit: name, description, guidance, offset_days,
//     recurring_interval_days, default_urgency, default_assignee_email
//   - Cannot: add templates, delete templates, change slug or
//     anchor_event (slug identifies the template across the codebase;
//     anchor_event would need a migration)

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Clock, Pencil, X, Save } from 'lucide-react';
import { CollapsibleCard } from '../../shared/components/CollapsibleCard';
import { loadFollowUpTemplates, updateFollowUpTemplate } from '../../lib/followUpTasks';
import btn from '../../styles/buttons.module.css';

export function FollowUpTemplateSettings({ showToast }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await loadFollowUpTemplates();
      if (cancelled) return;
      setTemplates(list);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const applyPatch = (id, patch) => {
    setTemplates((prev) => prev.map((t) => t.id === id ? { ...t, ...patch } : t));
  };

  const toggleEnabled = async (template) => {
    const before = template.enabled;
    applyPatch(template.id, { enabled: !before });
    const { error } = await updateFollowUpTemplate(template.id, { enabled: !before });
    if (error) {
      applyPatch(template.id, { enabled: before });
      showToast?.('Could not update template — please try again');
    } else {
      showToast?.(!before ? 'Template enabled' : 'Template disabled');
    }
  };

  const saveEdit = async (id, patch) => {
    const before = templates.find((t) => t.id === id);
    applyPatch(id, patch);
    setEditingId(null);
    const { error } = await updateFollowUpTemplate(id, patch);
    if (error) {
      applyPatch(id, before);
      setEditingId(id);
      showToast?.(error.message || 'Could not save changes');
      return false;
    }
    showToast?.('Template updated');
    return true;
  };

  return (
    <CollapsibleCard
      title="Follow-up Templates"
      description="Cadence for caregiver-match follow-ups"
    >
      <div style={{ padding: '20px 24px' }}>
        <p style={descStyle}>
          Each time a caregiver is assigned to a new client in the schedule, the system
          automatically generates a follow-up task for every enabled template here.
          The first task lands on the Tasks dashboard on the day of the first scheduled shift.
        </p>

        {loading ? (
          <div style={loadingStyle}>Loading templates...</div>
        ) : templates.length === 0 ? (
          <div style={loadingStyle}>No templates found for this organization.</div>
        ) : (
          <div style={listStyle}>
            {templates.map((t) => (
              <TemplateRow
                key={t.id}
                template={t}
                isEditing={editingId === t.id}
                onEditStart={() => setEditingId(t.id)}
                onEditCancel={() => setEditingId(null)}
                onToggle={() => toggleEnabled(t)}
                onSave={(patch) => saveEdit(t.id, patch)}
              />
            ))}
          </div>
        )}
      </div>
    </CollapsibleCard>
  );
}

// ─── TemplateRow ───────────────────────────────────────────

function TemplateRow({ template, isEditing, onEditStart, onEditCancel, onToggle, onSave }) {
  if (isEditing) {
    return <EditForm template={template} onCancel={onEditCancel} onSave={onSave} />;
  }
  return (
    <div style={rowStyle(template.enabled)}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={rowTitleStyle}>
          <UrgencyBadge urgency={template.default_urgency} />
          <span style={{ fontWeight: 600, marginLeft: 6 }}>{template.name}</span>
          {!template.enabled && <span style={disabledTagStyle}>Disabled</span>}
        </div>
        <div style={rowMetaStyle}>
          Fires <strong>{cadenceLabel(template)}</strong>
          {template.default_assignee_email && (
            <> · Default assignee: {template.default_assignee_email}</>
          )}
        </div>
        {template.description && (
          <div style={rowDescStyle}>{template.description}</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className={btn.secondaryBtn}
          onClick={onToggle}
          aria-label={template.enabled ? 'Disable template' : 'Enable template'}
        >
          {template.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          className={btn.secondaryBtn}
          onClick={onEditStart}
        >
          <Pencil size={13} style={{ marginRight: 4, verticalAlign: 'text-bottom' }} />
          Edit
        </button>
      </div>
    </div>
  );
}

// ─── EditForm ──────────────────────────────────────────────

function EditForm({ template, onCancel, onSave }) {
  const [name, setName] = useState(template.name || '');
  const [description, setDescription] = useState(template.description || '');
  const [guidance, setGuidance] = useState(template.guidance || '');
  const [offsetDays, setOffsetDays] = useState(String(template.offset_days ?? 0));
  const [recurring, setRecurring] = useState(template.recurring_interval_days != null ? String(template.recurring_interval_days) : '');
  const [urgency, setUrgency] = useState(template.default_urgency || 'warning');
  const [assignee, setAssignee] = useState(template.default_assignee_email || '');
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const ok = await onSave({
      name: name.trim() || template.name,
      description: description.trim() || null,
      guidance: guidance.trim() || null,
      offset_days: Number(offsetDays) || 0,
      recurring_interval_days: recurring.trim() === '' ? null : Number(recurring),
      default_urgency: urgency,
      default_assignee_email: assignee.trim() || null,
    });
    setSaving(false);
  };

  return (
    <form onSubmit={onSubmit} style={editFormStyle}>
      <div style={fieldGridStyle}>
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
            required
          />
        </Field>
        <Field label="Default urgency">
          <select value={urgency} onChange={(e) => setUrgency(e.target.value)} style={inputStyle}>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </Field>
        <Field label="Offset days (from first shift)" helpText="0 = day of first shift">
          <input
            type="number"
            min="0"
            value={offsetDays}
            onChange={(e) => setOffsetDays(e.target.value)}
            style={inputStyle}
            required
          />
        </Field>
        <Field label="Recurring every N days" helpText="Leave empty for a one-shot task">
          <input
            type="number"
            min="1"
            value={recurring}
            onChange={(e) => setRecurring(e.target.value)}
            style={inputStyle}
            placeholder="(none)"
          />
        </Field>
        <Field label="Default assignee email" helpText="Optional — staff member who normally owns this task" full>
          <input
            type="email"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            style={inputStyle}
            placeholder="e.g. jess@tremendouscareca.com"
          />
        </Field>
        <Field label="Description" full>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={inputStyle}
            placeholder="Brief description shown under the title"
          />
        </Field>
        <Field label="Guidance script" helpText="What the assignee should say or do. Shown when the task is expanded." full>
          <textarea
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            style={{ ...inputStyle, minHeight: 100, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button type="button" className={btn.secondaryBtn} onClick={onCancel} disabled={saving}>
          <X size={13} style={{ marginRight: 4, verticalAlign: 'text-bottom' }} />
          Cancel
        </button>
        <button type="submit" className={btn.primaryBtn} disabled={saving}>
          <Save size={13} style={{ marginRight: 4, verticalAlign: 'text-bottom' }} />
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function Field({ label, helpText, full, children }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto' }}>
      <label style={labelStyle}>{label}</label>
      {children}
      {helpText && <div style={helpStyle}>{helpText}</div>}
    </div>
  );
}

function UrgencyBadge({ urgency }) {
  if (urgency === 'critical') return <AlertTriangle size={14} style={{ color: '#DC3545' }} />;
  if (urgency === 'warning')  return <Clock size={14} style={{ color: '#D97706' }} />;
  return <CheckCircle2 size={14} style={{ color: '#1084C3' }} />;
}

function cadenceLabel(t) {
  const offset = t.offset_days === 0
    ? 'on the day of the first shift'
    : `${t.offset_days} days after the first shift`;
  const recur = t.recurring_interval_days
    ? `, then every ${t.recurring_interval_days} days`
    : '';
  return offset + recur;
}

// ─── Inline styles ─────────────────────────────────────────

const descStyle = { fontSize: 13, color: '#5D6B7F', marginBottom: 16, lineHeight: 1.5 };
const loadingStyle = { color: '#7A8BA0', fontSize: 13, padding: 12 };
const listStyle = { display: 'flex', flexDirection: 'column', gap: 12 };

function rowStyle(enabled) {
  return {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: 16, border: '1px solid #E0E4EA', borderRadius: 10,
    background: enabled ? '#fff' : '#FAFBFC',
    opacity: enabled ? 1 : 0.7,
    gap: 16,
  };
}

const rowTitleStyle = { display: 'flex', alignItems: 'center', fontSize: 14, marginBottom: 4 };
const rowMetaStyle = { fontSize: 12, color: '#5D6B7F' };
const rowDescStyle = { fontSize: 12, color: '#7A8BA0', marginTop: 6 };

const disabledTagStyle = {
  marginLeft: 8, fontSize: 10, padding: '2px 8px', borderRadius: 999,
  background: '#F2F4F8', color: '#7A8BA0', fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const editFormStyle = {
  padding: 16, border: '1px solid var(--tc-cyan)',
  borderRadius: 10, background: '#FBFDFE',
};

const fieldGridStyle = {
  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
};

const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.8px', color: '#5D6B7F', marginBottom: 4,
};

const inputStyle = {
  width: '100%', padding: '8px 10px', border: '1px solid #E0E4EA',
  borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box',
};

const helpStyle = { fontSize: 11, color: '#7A8BA0', marginTop: 4 };
