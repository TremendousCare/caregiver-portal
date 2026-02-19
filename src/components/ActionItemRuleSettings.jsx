import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { PHASES } from '../lib/constants';
import { getPhaseTasks } from '../lib/storage';
import { CLIENT_PHASES } from '../features/clients/constants';
import { getClientPhaseTasks } from '../features/clients/storage';
import { loadActionItemRules } from '../lib/actionItemEngine';
import btn from '../styles/buttons.module.css';
import forms from '../styles/forms.module.css';
import cards from '../styles/cards.module.css';

// ─── Entity Types ───
const ENTITY_TYPES = [
  { value: 'caregiver', label: 'Caregiver', icon: '\uD83D\uDC64' },
  { value: 'client', label: 'Client', icon: '\uD83C\uDFE0' },
];

// ─── Condition Types ───
const CONDITION_TYPES = [
  { value: 'phase_time', label: 'Time in Phase', description: 'Triggers when entity has been in a phase for X days' },
  { value: 'task_incomplete', label: 'Task Not Done', description: 'Triggers when a task is not completed after X days' },
  { value: 'task_stale', label: 'Task Done but Follow-up Missing', description: 'Triggers when a task is done but follow-up task is still incomplete' },
  { value: 'date_expiring', label: 'Date Expiring', description: 'Triggers when a date field is approaching or past expiration' },
  { value: 'time_since_creation', label: 'Time Since Created', description: 'Triggers based on time since record was created' },
  { value: 'last_note_stale', label: 'No Recent Notes', description: 'Triggers when no notes have been added in X days' },
  { value: 'sprint_deadline', label: 'Sprint Deadline', description: 'Triggers based on a multi-day sprint with warning/critical/expired thresholds' },
];

// ─── Urgency Options ───
const URGENCY_OPTIONS = [
  { value: 'critical', label: 'Critical', color: '#DC3545' },
  { value: 'warning', label: 'Warning', color: '#D97706' },
  { value: 'info', label: 'Info', color: '#1084C3' },
];

// ─── Merge Fields ───
const MERGE_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'days_in_phase', label: 'Days in Phase' },
  { key: 'days_since_created', label: 'Days Since Created' },
  { key: 'days_until_expiry', label: 'Days Until Expiry' },
  { key: 'expiry_date', label: 'Expiry Date' },
  { key: 'phase_name', label: 'Phase Name' },
  { key: 'sprint_day', label: 'Sprint Day' },
  { key: 'sprint_remaining', label: 'Sprint Remaining' },
  { key: 'task_name', label: 'Task Name' },
  { key: 'minutes_since_created', label: 'Minutes Since Created' },
  { key: 'days_since_last_note', label: 'Days Since Last Note' },
];

// ─── Date Field Options ───
const DATE_FIELDS = [
  { value: 'hcaExpiration', label: 'HCA Expiration' },
];

// ─── Helper: generate ID from name ───
function generateId(entityType, name) {
  const prefix = entityType === 'caregiver' ? 'cg_' : 'cl_';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return prefix + slug;
}

// ═════════════════════════════════════════════════════════════
// ActionItemRuleSettings Component
// ═════════════════════════════════════════════════════════════

export default function ActionItemRuleSettings({ showToast, currentUserEmail }) {
  const [rules, setRules] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(null);
  const [activeEntityType, setActiveEntityType] = useState('caregiver');

  // ─── Form state ───
  const [formName, setFormName] = useState('');
  const [formEntityType, setFormEntityType] = useState('caregiver');
  const [formConditionType, setFormConditionType] = useState('phase_time');
  const [formConditionConfig, setFormConditionConfig] = useState({});
  const [formUrgency, setFormUrgency] = useState('warning');
  const [formEscalation, setFormEscalation] = useState(null);
  const [formIcon, setFormIcon] = useState('📋');
  const [formTitle, setFormTitle] = useState('');
  const [formDetail, setFormDetail] = useState('');
  const [formAction, setFormAction] = useState('');
  const [formError, setFormError] = useState('');

  const titleRef = useRef(null);
  const detailRef = useRef(null);
  const actionRef = useRef(null);

  // ─── Load rules ───
  const loadRules = useCallback(async () => {
    const { data, error } = await supabase
      .from('action_item_rules')
      .select('*')
      .order('sort_order', { ascending: true });
    if (!error && data) setRules(data);
  }, []);

  useEffect(() => { loadRules(); }, [loadRules]);

  // ─── Get phases/tasks for current entity type ───
  const phases = activeEntityType === 'caregiver' ? PHASES : CLIENT_PHASES;
  const phaseTasks = activeEntityType === 'caregiver' ? getPhaseTasks() : getClientPhaseTasks();
  const formPhases = formEntityType === 'caregiver' ? PHASES : CLIENT_PHASES;
  const formPhaseTasks = formEntityType === 'caregiver' ? getPhaseTasks() : getClientPhaseTasks();

  // ─── Filtered rules ───
  const filteredRules = rules.filter((r) => r.entity_type === activeEntityType);

  // ─── Insert merge field ───
  const insertMergeField = (field, ref) => {
    const el = ref?.current;
    if (!el) return;
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    const val = el.value;
    const tag = `{{${field}}}`;
    const newVal = val.substring(0, start) + tag + val.substring(end);

    // Update the correct form field
    if (ref === titleRef) setFormTitle(newVal);
    else if (ref === detailRef) setFormDetail(newVal);
    else if (ref === actionRef) setFormAction(newVal);

    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + tag.length, start + tag.length);
    }, 0);
  };

  // ─── Open form for new rule ───
  const handleAdd = () => {
    setEditingRule(null);
    setFormName('');
    setFormEntityType(activeEntityType);
    setFormConditionType('phase_time');
    setFormConditionConfig({});
    setFormUrgency('warning');
    setFormEscalation(null);
    setFormIcon('📋');
    setFormTitle('');
    setFormDetail('');
    setFormAction('');
    setFormError('');
    setShowForm(true);
  };

  // ─── Open form for edit ───
  const handleEdit = (rule) => {
    setEditingRule(rule);
    setFormName(rule.name);
    setFormEntityType(rule.entity_type);
    setFormConditionType(rule.condition_type);
    setFormConditionConfig(rule.condition_config || {});
    setFormUrgency(rule.urgency);
    setFormEscalation(rule.urgency_escalation || null);
    setFormIcon(rule.icon || '📋');
    setFormTitle(rule.title_template || '');
    setFormDetail(rule.detail_template || '');
    setFormAction(rule.action_template || '');
    setFormError('');
    setShowForm(true);
  };

  // ─── Save ───
  const handleSave = async () => {
    if (!formName.trim()) { setFormError('Rule name is required'); return; }
    if (!formTitle.trim()) { setFormError('Title template is required'); return; }

    setSaving(true);
    setFormError('');

    const payload = {
      name: formName.trim(),
      entity_type: formEntityType,
      condition_type: formConditionType,
      condition_config: formConditionConfig,
      urgency: formUrgency,
      urgency_escalation: formEscalation,
      icon: formIcon || '📋',
      title_template: formTitle.trim(),
      detail_template: formDetail.trim(),
      action_template: formAction.trim(),
      updated_at: new Date().toISOString(),
      updated_by: currentUserEmail,
    };

    let error;
    if (editingRule) {
      ({ error } = await supabase.from('action_item_rules').update(payload).eq('id', editingRule.id));
    } else {
      payload.id = generateId(formEntityType, formName);
      payload.created_at = new Date().toISOString();
      payload.created_by = currentUserEmail;
      payload.sort_order = filteredRules.length * 10;
      payload.enabled = true;
      ({ error } = await supabase.from('action_item_rules').insert(payload));
    }

    setSaving(false);
    if (error) {
      setFormError(error.message);
    } else {
      setShowForm(false);
      showToast(editingRule ? 'Rule updated' : 'Rule created');
      loadRules();
      loadActionItemRules(); // refresh engine cache
    }
  };

  // ─── Toggle ───
  const handleToggle = async (rule) => {
    setToggling(rule.id);
    const { error } = await supabase
      .from('action_item_rules')
      .update({ enabled: !rule.enabled, updated_at: new Date().toISOString(), updated_by: currentUserEmail })
      .eq('id', rule.id);
    setToggling(null);
    if (!error) {
      loadRules();
      loadActionItemRules();
    }
  };

  // ─── Delete ───
  const handleDelete = async (rule) => {
    if (!window.confirm(`Delete "${rule.name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from('action_item_rules').delete().eq('id', rule.id);
    if (!error) {
      showToast('Rule deleted');
      loadRules();
      loadActionItemRules();
    }
  };

  // ─── Update config field helper ───
  const setConfig = (key, value) => {
    setFormConditionConfig((prev) => ({ ...prev, [key]: value }));
  };

  // ─── All tasks for form dropdowns ───
  const allFormTasks = Object.entries(formPhaseTasks).flatMap(([phaseId, tasks]) =>
    (tasks || []).map((t) => ({ ...t, phaseId }))
  );

  // ═════════════════════════════════════════════════════════════
  // Render
  // ═════════════════════════════════════════════════════════════

  return (
    <div className={cards.profileCard}>
      <div className={cards.profileCardHeader}>
        <h3 className={cards.profileCardTitle}>Action Item Rules</h3>
        <button className={btn.primaryBtn} onClick={handleAdd} style={{ fontSize: 13, padding: '6px 14px' }}>
          + Add Rule
        </button>
      </div>

      {/* Entity Type Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, padding: '0 20px' }}>
        {ENTITY_TYPES.map((et) => {
          const count = rules.filter((r) => r.entity_type === et.value).length;
          return (
            <button key={et.value} onClick={() => setActiveEntityType(et.value)} style={{
              padding: '6px 14px', fontSize: 13, border: '1px solid #DDE2E8', borderRadius: 6, cursor: 'pointer',
              background: activeEntityType === et.value ? '#2E4E8D' : '#fff',
              color: activeEntityType === et.value ? '#fff' : '#4A5568',
              fontWeight: activeEntityType === et.value ? 600 : 400,
            }}>
              {et.icon} {et.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Rules List */}
      <div style={{ padding: '0 20px 20px' }}>
        {filteredRules.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#7A8BA0', padding: '30px 0', fontSize: 14 }}>
            No action item rules for {activeEntityType}s yet. Click "+ Add Rule" to create one.
          </div>
        ) : (
          <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 80px 70px 130px', gap: 8, padding: '10px 14px', background: '#F8F9FB', borderBottom: '1px solid #E2E8F0', fontSize: 11, fontWeight: 600, color: '#7A8BA0', textTransform: 'uppercase' }}>
              <span>Rule</span>
              <span>Condition</span>
              <span>Urgency</span>
              <span>Active</span>
              <span></span>
            </div>
            {/* Rows */}
            {filteredRules.map((rule) => (
              <div key={rule.id} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 80px 70px 130px', gap: 8, padding: '10px 14px', borderBottom: '1px solid #F0F0F0', alignItems: 'center', fontSize: 13 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{rule.icon} {rule.name}</div>
                  <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 2 }}>{rule.title_template}</div>
                </div>
                <ConditionBadge type={rule.condition_type} />
                <UrgencyBadge urgency={rule.urgency} />
                <label style={{ position: 'relative', display: 'inline-block', width: 36, height: 20, cursor: 'pointer' }}>
                  <input type="checkbox" checked={rule.enabled} onChange={() => handleToggle(rule)} disabled={toggling === rule.id}
                    style={{ opacity: 0, width: 0, height: 0 }} />
                  <span style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 10,
                    background: rule.enabled ? '#16A34A' : '#CBD5E1', transition: 'background 0.2s',
                  }}>
                    <span style={{
                      position: 'absolute', top: 2, left: rule.enabled ? 18 : 2, width: 16, height: 16,
                      background: '#fff', borderRadius: '50%', transition: 'left 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                    }} />
                  </span>
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className={btn.secondaryBtn} onClick={() => handleEdit(rule)} style={{ fontSize: 12, padding: '4px 10px' }}>Edit</button>
                  <button onClick={() => handleDelete(rule)} style={{ fontSize: 12, padding: '4px 10px', background: '#FEF2F2', color: '#DC3545', border: '1px solid #FECACA', borderRadius: 6, cursor: 'pointer' }}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Form Modal ─── */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: '100%', maxWidth: 580, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <h3 style={{ margin: '0 0 20px', fontSize: 18, fontWeight: 700 }}>
              {editingRule ? 'Edit Rule' : 'Create Action Item Rule'}
            </h3>

            {/* Rule Name */}
            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Rule Name</label>
              <input className={forms.fieldInput} value={formName} onChange={(e) => { setFormName(e.target.value); setFormError(''); }}
                placeholder="e.g., Interview not scheduled" />
            </div>

            {/* Entity Type */}
            {!editingRule && (
              <div style={{ marginBottom: 16 }}>
                <label className={forms.fieldLabel}>Entity Type</label>
                <select className={forms.fieldInput} value={formEntityType} onChange={(e) => {
                  setFormEntityType(e.target.value);
                  setFormConditionConfig({});
                }}>
                  {ENTITY_TYPES.map((et) => <option key={et.value} value={et.value}>{et.label}</option>)}
                </select>
              </div>
            )}

            {/* Condition Type */}
            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Condition Type</label>
              <select className={forms.fieldInput} value={formConditionType} onChange={(e) => {
                setFormConditionType(e.target.value);
                setFormConditionConfig({});
              }}>
                {CONDITION_TYPES.map((ct) => <option key={ct.value} value={ct.value}>{ct.label}</option>)}
              </select>
              <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 4 }}>
                {CONDITION_TYPES.find((c) => c.value === formConditionType)?.description}
              </div>
            </div>

            {/* ─── Condition Config (dynamic) ─── */}
            <div style={{ background: '#F8F9FB', borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#4A5568', marginBottom: 10 }}>Condition Settings</div>

              {/* Phase selector (most condition types) */}
              {['phase_time', 'task_incomplete', 'task_stale', 'last_note_stale', 'sprint_deadline', 'time_since_creation'].includes(formConditionType) && (
                <div style={{ marginBottom: 12 }}>
                  <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Phase</label>
                  <select className={forms.fieldInput} value={formConditionConfig.phase || ''} onChange={(e) => setConfig('phase', e.target.value || undefined)}>
                    <option value="">Any phase</option>
                    {formConditionType === 'phase_time' && <option value="_any_active">Any active phase (with exclusions)</option>}
                    {formPhases.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>
              )}

              {/* Exclude phases (for _any_active) */}
              {formConditionType === 'phase_time' && formConditionConfig.phase === '_any_active' && (
                <div style={{ marginBottom: 12 }}>
                  <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Exclude Phases (comma-separated)</label>
                  <input className={forms.fieldInput} value={(formConditionConfig.exclude_phases || []).join(', ')} onChange={(e) =>
                    setConfig('exclude_phases', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))
                  } placeholder="e.g., won, lost, nurture" />
                </div>
              )}

              {/* Min days (phase_time, task_incomplete, task_stale, last_note_stale) */}
              {['phase_time', 'task_incomplete', 'task_stale', 'last_note_stale'].includes(formConditionType) && (
                <div style={{ marginBottom: 12 }}>
                  <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Minimum Days</label>
                  <input className={forms.fieldInput} type="number" min="0" value={formConditionConfig.min_days || ''} onChange={(e) => setConfig('min_days', parseInt(e.target.value) || 0)} />
                </div>
              )}

              {/* Task ID (task_incomplete) */}
              {formConditionType === 'task_incomplete' && (
                <div style={{ marginBottom: 12 }}>
                  <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Task (must be incomplete)</label>
                  <select className={forms.fieldInput} value={formConditionConfig.task_id || ''} onChange={(e) => setConfig('task_id', e.target.value)}>
                    <option value="">Select task...</option>
                    {allFormTasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </div>
              )}

              {/* Done task + Pending task (task_stale) */}
              {formConditionType === 'task_stale' && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Completed Task</label>
                    <select className={forms.fieldInput} value={formConditionConfig.done_task_id || ''} onChange={(e) => setConfig('done_task_id', e.target.value)}>
                      <option value="">Select task...</option>
                      {allFormTasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Pending Follow-up Task</label>
                    <select className={forms.fieldInput} value={formConditionConfig.pending_task_id || ''} onChange={(e) => setConfig('pending_task_id', e.target.value)}>
                      <option value="">Select task...</option>
                      {allFormTasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                </>
              )}

              {/* Date field + thresholds (date_expiring) */}
              {formConditionType === 'date_expiring' && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Date Field</label>
                    <select className={forms.fieldInput} value={formConditionConfig.field || ''} onChange={(e) => setConfig('field', e.target.value)}>
                      <option value="">Select field...</option>
                      {DATE_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Days Warning Window</label>
                      <input className={forms.fieldInput} type="number" min="0" value={formConditionConfig.days_warning || ''} onChange={(e) => setConfig('days_warning', parseInt(e.target.value) || 0)} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Exclude Under (days)</label>
                      <input className={forms.fieldInput} type="number" min="0" value={formConditionConfig.days_exclude_under || ''} onChange={(e) => setConfig('days_exclude_under', parseInt(e.target.value) || 0)} />
                    </div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input type="checkbox" checked={formConditionConfig.days_until !== undefined && formConditionConfig.days_until < 0}
                        onChange={(e) => setConfig('days_until', e.target.checked ? -1 : undefined)} />
                      Check for already expired (past date)
                    </label>
                  </div>
                </>
              )}

              {/* Minutes / Days (time_since_creation) */}
              {formConditionType === 'time_since_creation' && (
                <>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Minimum Minutes</label>
                      <input className={forms.fieldInput} type="number" min="0" value={formConditionConfig.min_minutes || ''} onChange={(e) => setConfig('min_minutes', parseInt(e.target.value) || undefined)} placeholder="e.g., 30" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className={forms.fieldLabel} style={{ fontSize: 12 }}>— or — Minimum Days</label>
                      <input className={forms.fieldInput} type="number" min="0" value={formConditionConfig.min_days || ''} onChange={(e) => setConfig('min_days', parseInt(e.target.value) || undefined)} placeholder="e.g., 1" />
                    </div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Task Not Done (optional)</label>
                    <select className={forms.fieldInput} value={formConditionConfig.task_not_done || ''} onChange={(e) => setConfig('task_not_done', e.target.value || undefined)}>
                      <option value="">No task check</option>
                      {allFormTasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                </>
              )}

              {/* Sprint thresholds */}
              {formConditionType === 'sprint_deadline' && (
                <div style={{ display: 'flex', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Warning Day</label>
                    <input className={forms.fieldInput} type="number" min="1" value={formConditionConfig.warning_day || ''} onChange={(e) => setConfig('warning_day', parseInt(e.target.value) || 0)} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Critical Day</label>
                    <input className={forms.fieldInput} type="number" min="1" value={formConditionConfig.critical_day || ''} onChange={(e) => setConfig('critical_day', parseInt(e.target.value) || 0)} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className={forms.fieldLabel} style={{ fontSize: 12 }}>Expired Day</label>
                    <input className={forms.fieldInput} type="number" min="1" value={formConditionConfig.expired_day || ''} onChange={(e) => setConfig('expired_day', parseInt(e.target.value) || 0)} />
                  </div>
                </div>
              )}
            </div>

            {/* Urgency */}
            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Urgency Level</label>
              <select className={forms.fieldInput} value={formUrgency} onChange={(e) => setFormUrgency(e.target.value)}>
                {URGENCY_OPTIONS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </div>

            {/* Urgency Escalation */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
                <input type="checkbox" checked={!!formEscalation} onChange={(e) =>
                  setFormEscalation(e.target.checked ? { min_days: 5, urgency: 'critical' } : null)
                } />
                Auto-escalate urgency after more days
              </label>
              {formEscalation && (
                <div style={{ display: 'flex', gap: 12, padding: '10px 14px', background: '#FFF8ED', borderRadius: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label className={forms.fieldLabel} style={{ fontSize: 11 }}>After Days</label>
                    <input className={forms.fieldInput} type="number" min="1" value={formEscalation.min_days || ''} onChange={(e) =>
                      setFormEscalation({ ...formEscalation, min_days: parseInt(e.target.value) || 0 })
                    } />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className={forms.fieldLabel} style={{ fontSize: 11 }}>Escalate To</label>
                    <select className={forms.fieldInput} value={formEscalation.urgency || 'critical'} onChange={(e) =>
                      setFormEscalation({ ...formEscalation, urgency: e.target.value })
                    }>
                      {URGENCY_OPTIONS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Icon */}
            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Icon (emoji)</label>
              <input className={forms.fieldInput} value={formIcon} onChange={(e) => setFormIcon(e.target.value)} style={{ width: 80 }} />
            </div>

            {/* Title Template */}
            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Title Template</label>
              <input ref={titleRef} className={forms.fieldInput} value={formTitle} onChange={(e) => { setFormTitle(e.target.value); setFormError(''); }}
                placeholder="e.g., Interview not yet scheduled" />
              <MergeFieldChips onClick={(key) => insertMergeField(key, titleRef)} />
            </div>

            {/* Detail Template */}
            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Detail Template</label>
              <textarea ref={detailRef} className={forms.textarea || forms.fieldInput} value={formDetail} onChange={(e) => setFormDetail(e.target.value)}
                rows={2} placeholder="e.g., Day {{days_in_phase}} — Goal is 24 hours" style={{ resize: 'vertical' }} />
              <MergeFieldChips onClick={(key) => insertMergeField(key, detailRef)} />
            </div>

            {/* Action Template */}
            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Suggested Action Template</label>
              <textarea ref={actionRef} className={forms.textarea || forms.fieldInput} value={formAction} onChange={(e) => setFormAction(e.target.value)}
                rows={2} placeholder="e.g., Schedule virtual interview now" style={{ resize: 'vertical' }} />
              <MergeFieldChips onClick={(key) => insertMergeField(key, actionRef)} />
            </div>

            {/* Error */}
            {formError && <div style={{ color: '#DC3545', fontSize: 13, marginBottom: 12 }}>{formError}</div>}

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className={btn.secondaryBtn} onClick={() => setShowForm(false)}>Cancel</button>
              <button className={btn.primaryBtn} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : editingRule ? 'Update Rule' : 'Create Rule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Badge Components ────────────────────────────────────────

function ConditionBadge({ type }) {
  const colors = {
    phase_time: { bg: '#EFF6FF', text: '#1D4ED8', border: '#BFDBFE' },
    task_incomplete: { bg: '#FFFBEB', text: '#A16207', border: '#FDE68A' },
    task_stale: { bg: '#FFF1F2', text: '#BE123C', border: '#FECDD3' },
    date_expiring: { bg: '#F0FDF4', text: '#15803D', border: '#BBF7D0' },
    time_since_creation: { bg: '#F5F3FF', text: '#6D28D9', border: '#DDD6FE' },
    last_note_stale: { bg: '#FEF3C7', text: '#92400E', border: '#FDE68A' },
    sprint_deadline: { bg: '#FFF7ED', text: '#C2410C', border: '#FED7AA' },
  };
  const labels = {
    phase_time: 'Phase Time',
    task_incomplete: 'Task Missing',
    task_stale: 'Stale Task',
    date_expiring: 'Date Expiry',
    time_since_creation: 'Since Created',
    last_note_stale: 'No Notes',
    sprint_deadline: 'Sprint',
  };
  const c = colors[type] || { bg: '#F1F5F9', text: '#475569', border: '#E2E8F0' };
  return (
    <span style={{ padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: c.bg, color: c.text, border: `1px solid ${c.border}` }}>
      {labels[type] || type}
    </span>
  );
}

function UrgencyBadge({ urgency }) {
  const colors = {
    critical: { bg: '#FEF2F0', text: '#DC3545', border: '#FECACA' },
    warning: { bg: '#FFF8ED', text: '#D97706', border: '#FDE68A' },
    info: { bg: '#EBF5FB', text: '#1084C3', border: '#BFDBFE' },
  };
  const labels = { critical: 'Critical', warning: 'Warning', info: 'Info' };
  const c = colors[urgency] || colors.info;
  return (
    <span style={{ padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: c.bg, color: c.text, border: `1px solid ${c.border}` }}>
      {labels[urgency] || urgency}
    </span>
  );
}

function MergeFieldChips({ onClick }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
      {MERGE_FIELDS.map((f) => (
        <button key={f.key} onClick={() => onClick(f.key)} type="button" style={{
          padding: '2px 8px', fontSize: 10, borderRadius: 4, border: '1px solid #DDE2E8',
          background: '#F8F9FB', color: '#4A5568', cursor: 'pointer',
        }}>
          {`{{${f.key}}}`}
        </button>
      ))}
    </div>
  );
}
