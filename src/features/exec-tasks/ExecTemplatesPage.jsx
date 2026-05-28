import { useMemo, useState } from 'react';
import { RefreshCw, FileText, AlertCircle, Calendar, Plus } from 'lucide-react';
import { useApp } from '../../shared/context/AppContext';
import { useExecTemplates } from './hooks/useExecTemplates';
import { needsNextFireDate } from './lib/templatesQueries';
import { Modal } from './components/Modal';
import s from './ExecTasksPage.module.css';

const CATEGORY_LABEL = {
  lifecycle: 'Lifecycle (hire-date anchored)',
  recurring: 'Recurring (date-cadenced)',
  ad_hoc:    'Ad-hoc',
};
const CATEGORY_CLS = {
  lifecycle: s.lifecycle,
  recurring: s.recurring,
  ad_hoc:    s.adhoc,
};

function formatCadence(t) {
  if (t.anchor_type === 'hire_date') {
    return `Fires ${t.offset_days} day${t.offset_days === 1 ? '' : 's'} after hire date`;
  }
  if (t.anchor_type === 'fixed_date') {
    const d = t.recurrence_interval_days;
    if (!d) return 'Recurring';
    if (d <= 7) return 'Weekly';
    if (d <= 31) return 'Monthly';
    if (d <= 100) return 'Quarterly';
    if (d >= 200) return 'Annual';
    return `Every ${d} days`;
  }
  return 'Manual (owner creates instances)';
}

function formatNextFire(t) {
  if (!t.next_fire_at) return null;
  const d = new Date(t.next_fire_at);
  if (Number.isNaN(d.getTime())) return t.next_fire_at;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ExecTemplatesPage() {
  const { showToast } = useApp();
  const { loading, submitting, templates, error, refresh, updateTemplate, createTemplate } = useExecTemplates();
  const [editing, setEditing] = useState(null); // template
  const [creating, setCreating] = useState(false);

  const grouped = useMemo(() => {
    const buckets = { lifecycle: [], recurring: [], ad_hoc: [] };
    for (const t of templates ?? []) {
      (buckets[t.category] ?? buckets.ad_hoc).push(t);
    }
    return buckets;
  }, [templates]);

  async function handleToggleActive(t) {
    try {
      await updateTemplate(t.id, { active: !t.active });
      showToast?.(t.active ? `Disabled "${t.name}"` : `Enabled "${t.name}"`);
    } catch (e) {
      // The owner needs to see this — common case: missed next_fire_at.
      window.alert(e?.message ?? 'Could not toggle template.');
    }
  }

  async function handleSaveEdit(patch) {
    try {
      await updateTemplate(editing.id, patch);
      showToast?.(`Updated "${editing.name}"`);
      setEditing(null);
    } catch (e) {
      window.alert(e?.message ?? 'Could not save.');
    }
  }

  // Errors propagate to the form so it can show them inline; success
  // closes the modal. New templates land inactive, so call that out.
  async function handleCreate(draft) {
    await createTemplate(draft);
    showToast?.(`Created "${draft.name.trim()}" — inactive until you toggle it on`);
    setCreating(false);
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>
            <FileText size={26} style={{ verticalAlign: 'middle', marginRight: 8 }} />
            Task templates
          </h1>
          <p className={s.subtitle}>
            Blueprints for recurring + lifecycle executive work. Toggle each on when you&rsquo;re ready
            — the daily generator (10:00 UTC) materializes instances onto the Tasks page.
          </p>
        </div>
        <div className={s.headerRight}>
          <button type="button" className={s.secondaryBtn} onClick={refresh}>
            <RefreshCw size={14} />
            Refresh
          </button>
          <button type="button" className={s.primaryBtn} onClick={() => setCreating(true)}>
            <Plus size={14} />
            New template
          </button>
        </div>
      </div>

      {error && (
        <div className={s.error}>
          <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {error?.message ?? 'Could not load templates.'}
        </div>
      )}

      {loading ? (
        <div className={s.empty}>Loading templates…</div>
      ) : (templates ?? []).length === 0 ? (
        <div className={s.empty}>
          <div className={s.emptyTitle}>No templates yet</div>
          <div>The seed migration should have created 25 templates. Run the Deploy Database Migrations workflow if you haven&rsquo;t already.</div>
        </div>
      ) : (
        <>
          {['lifecycle', 'recurring', 'ad_hoc'].map((cat) => {
            const list = grouped[cat] ?? [];
            if (list.length === 0) return null;
            return (
              <div key={cat} style={{ marginBottom: 20 }}>
                <h2 style={{
                  fontSize: 13, fontWeight: 700, color: '#5A6B85',
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                  margin: '0 0 8px',
                }}>
                  {CATEGORY_LABEL[cat]}
                </h2>
                <div className={s.templatesList}>
                  {list.map((t) => (
                    <TemplateRow
                      key={t.id}
                      template={t}
                      submitting={submitting}
                      onToggle={() => handleToggleActive(t)}
                      onEdit={() => setEditing(t)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}

      {editing && (
        <Modal title={`Edit template — ${editing.name}`} onClose={() => setEditing(null)}>
          <TemplateEditForm
            template={editing}
            submitting={submitting}
            onCancel={() => setEditing(null)}
            onSave={handleSaveEdit}
          />
        </Modal>
      )}

      {creating && (
        <Modal title="New template" onClose={() => setCreating(false)}>
          <TemplateCreateForm
            submitting={submitting}
            onCancel={() => setCreating(false)}
            onSave={handleCreate}
          />
        </Modal>
      )}
    </div>
  );
}

function TemplateRow({ template, submitting, onToggle, onEdit }) {
  const cadence = formatCadence(template);
  const nextFire = formatNextFire(template);
  const warn = needsNextFireDate(template);

  return (
    <div className={s.templateRow}>
      <div>
        <h3 className={s.templateName}>
          {template.name}
          <span className={`${s.categoryBadge} ${CATEGORY_CLS[template.category] ?? ''}`}>
            {template.category.replace('_', ' ')}
          </span>
        </h3>
        <p className={s.templateMeta}>
          {cadence}
          {nextFire && <> · Next fire: {nextFire}</>}
          {template.default_assignee_email && <> · Assignee: {template.default_assignee_email}</>}
        </p>
        {warn && (
          <p className={s.warnHint}>
            <Calendar size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Set a next-fire date before activating
          </p>
        )}
      </div>
      <button
        type="button"
        className={s.secondaryBtn}
        onClick={onEdit}
        disabled={submitting}
      >
        Edit
      </button>
      <label className={s.switch} title={template.active ? 'Active' : 'Inactive'}>
        <input
          type="checkbox"
          checked={template.active}
          onChange={onToggle}
          disabled={submitting}
        />
        <span className={s.slider} />
      </label>
    </div>
  );
}

function TemplateEditForm({ template, submitting, onCancel, onSave }) {
  const [name, setName]                       = useState(template.name);
  const [description, setDescription]         = useState(template.description ?? '');
  const [guidance, setGuidance]               = useState(template.guidance ?? '');
  const [offsetDays, setOffsetDays]           = useState(template.offset_days ?? '');
  const [intervalDays, setIntervalDays]       = useState(template.recurrence_interval_days ?? '');
  const [nextFireAt, setNextFireAt]           = useState(() => {
    if (!template.next_fire_at) return '';
    return template.next_fire_at.slice(0, 16); // YYYY-MM-DDTHH:mm
  });
  const [defaultAssignee, setDefaultAssignee] = useState(template.default_assignee_email ?? '');
  const [urgency, setUrgency]                 = useState(template.default_urgency ?? 'warning');
  const [sendEmail, setSendEmail]             = useState(template.send_email_on_notify === true);
  const [formError, setFormError]             = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    const patch = {
      name,
      description: description || null,
      guidance: guidance || null,
      default_assignee_email: defaultAssignee || null,
      default_urgency: urgency,
      send_email_on_notify: sendEmail,
    };
    if (template.anchor_type === 'hire_date') {
      patch.offset_days = offsetDays === '' ? null : Number(offsetDays);
    }
    if (template.anchor_type === 'fixed_date') {
      patch.recurrence_interval_days = intervalDays === '' ? null : Number(intervalDays);
      patch.next_fire_at = nextFireAt ? new Date(nextFireAt).toISOString() : null;
    }
    try {
      await onSave(patch);
    } catch (err) {
      setFormError(err?.message ?? 'Could not save.');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {formError && <div className={s.error}>{formError}</div>}

      <div className={s.field}>
        <label className={s.fieldLabel}>Name</label>
        <input
          className={s.input}
          type="text"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Description</label>
        <textarea
          className={s.textarea}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Guidance (shown when completing the task)</label>
        <textarea
          className={s.textarea}
          rows={3}
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
        />
      </div>

      {template.anchor_type === 'hire_date' && (
        <div className={s.field}>
          <label className={s.fieldLabel}>Days after hire date</label>
          <input
            className={s.input}
            type="number"
            min="0"
            value={offsetDays}
            onChange={(e) => setOffsetDays(e.target.value)}
          />
        </div>
      )}

      {template.anchor_type === 'fixed_date' && (
        <div className={s.twoCol}>
          <div className={s.field}>
            <label className={s.fieldLabel}>Recurrence interval (days)</label>
            <input
              className={s.input}
              type="number"
              min="1"
              value={intervalDays}
              onChange={(e) => setIntervalDays(e.target.value)}
            />
          </div>
          <div className={s.field}>
            <label className={s.fieldLabel}>Next fire (required to activate)</label>
            <input
              className={s.input}
              type="datetime-local"
              value={nextFireAt}
              onChange={(e) => setNextFireAt(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className={s.twoCol}>
        <div className={s.field}>
          <label className={s.fieldLabel}>Default assignee email</label>
          <input
            className={s.input}
            type="email"
            value={defaultAssignee}
            onChange={(e) => setDefaultAssignee(e.target.value)}
            placeholder="Leave blank to notify all owners"
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>Default urgency</label>
          <select className={s.select} value={urgency} onChange={(e) => setUrgency(e.target.value)}>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </div>
      </div>

      <label
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px', background: '#F7F8FB',
          border: '1px solid #E0E4EA', borderRadius: 10,
          marginBottom: 14, cursor: 'pointer', fontSize: 13,
        }}
      >
        <input
          type="checkbox"
          checked={sendEmail}
          onChange={(e) => setSendEmail(e.target.checked)}
          style={{ width: 16, height: 16, cursor: 'pointer' }}
        />
        <span>
          <strong>Also send email when the task is due</strong>
          <br />
          <span style={{ color: '#5A6B85', fontSize: 12 }}>
            The bell notification always fires. Turn this on for tasks where you also want a paper trail in the inbox.
          </span>
        </span>
      </label>

      <div className={s.modalActions}>
        <button type="button" className={s.secondaryBtn} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className={s.primaryBtn} disabled={submitting}>
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

const TEMPLATE_TYPE_OPTIONS = [
  { value: 'recurring', label: 'Recurring (date-cadenced)' },
  { value: 'lifecycle', label: 'Lifecycle (hire-date anchored)' },
  { value: 'ad_hoc',    label: 'Ad-hoc (you create instances by hand)' },
];

function TemplateCreateForm({ submitting, onCancel, onSave }) {
  const [name, setName]                       = useState('');
  const [templateType, setTemplateType]       = useState('recurring');
  const [description, setDescription]         = useState('');
  const [guidance, setGuidance]               = useState('');
  const [offsetDays, setOffsetDays]           = useState('');
  const [intervalDays, setIntervalDays]       = useState('');
  const [nextFireAt, setNextFireAt]           = useState('');
  const [defaultAssignee, setDefaultAssignee] = useState('');
  const [urgency, setUrgency]                 = useState('warning');
  const [sendEmail, setSendEmail]             = useState(false);
  const [formError, setFormError]             = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    const draft = {
      name,
      templateType,
      description,
      guidance,
      default_assignee_email: defaultAssignee,
      default_urgency: urgency,
      send_email_on_notify: sendEmail,
    };
    if (templateType === 'lifecycle') {
      draft.offset_days = offsetDays;
    }
    if (templateType === 'recurring') {
      draft.recurrence_interval_days = intervalDays;
      // datetime-local (no TZ) → UTC ISO, matching the edit form / DB timestamptz.
      draft.next_fire_at = nextFireAt ? new Date(nextFireAt).toISOString() : null;
    }
    try {
      await onSave(draft);
    } catch (err) {
      setFormError(err?.message ?? 'Could not create template.');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {formError && <div className={s.error}>{formError}</div>}

      <div className={s.field}>
        <label className={s.fieldLabel}>Name</label>
        <input
          className={s.input}
          type="text"
          required
          autoFocus
          maxLength={200}
          placeholder='e.g. "Monthly board update"'
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Template type</label>
        <select className={s.select} value={templateType} onChange={(e) => setTemplateType(e.target.value)}>
          {TEMPLATE_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Description</label>
        <textarea
          className={s.textarea}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel}>Guidance (shown when completing the task)</label>
        <textarea
          className={s.textarea}
          rows={3}
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
        />
      </div>

      {templateType === 'lifecycle' && (
        <div className={s.field}>
          <label className={s.fieldLabel}>Days after hire date</label>
          <input
            className={s.input}
            type="number"
            min="0"
            value={offsetDays}
            onChange={(e) => setOffsetDays(e.target.value)}
          />
        </div>
      )}

      {templateType === 'recurring' && (
        <div className={s.twoCol}>
          <div className={s.field}>
            <label className={s.fieldLabel}>Recurrence interval (days)</label>
            <input
              className={s.input}
              type="number"
              min="1"
              value={intervalDays}
              onChange={(e) => setIntervalDays(e.target.value)}
            />
          </div>
          <div className={s.field}>
            <label className={s.fieldLabel}>Next fire (optional — required to activate)</label>
            <input
              className={s.input}
              type="datetime-local"
              value={nextFireAt}
              onChange={(e) => setNextFireAt(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className={s.twoCol}>
        <div className={s.field}>
          <label className={s.fieldLabel}>Default assignee email</label>
          <input
            className={s.input}
            type="email"
            value={defaultAssignee}
            onChange={(e) => setDefaultAssignee(e.target.value)}
            placeholder="Leave blank to notify all owners"
          />
        </div>
        <div className={s.field}>
          <label className={s.fieldLabel}>Default urgency</label>
          <select className={s.select} value={urgency} onChange={(e) => setUrgency(e.target.value)}>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </div>
      </div>

      <label
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px', background: '#F7F8FB',
          border: '1px solid #E0E4EA', borderRadius: 10,
          marginBottom: 10, cursor: 'pointer', fontSize: 13,
        }}
      >
        <input
          type="checkbox"
          checked={sendEmail}
          onChange={(e) => setSendEmail(e.target.checked)}
          style={{ width: 16, height: 16, cursor: 'pointer' }}
        />
        <span>
          <strong>Also send email when the task is due</strong>
          <br />
          <span style={{ color: '#5A6B85', fontSize: 12 }}>
            Bell + toast always fire. Email is opt-in for tasks where you also want an inbox paper trail.
          </span>
        </span>
      </label>

      <p className={s.warnHint} style={{ marginTop: 4 }}>
        <Calendar size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
        New templates are created inactive — toggle it on once the wording and timing look right.
      </p>

      <div className={s.modalActions}>
        <button type="button" className={s.secondaryBtn} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" className={s.primaryBtn} disabled={submitting}>
          {submitting ? 'Creating…' : 'Create template'}
        </button>
      </div>
    </form>
  );
}
