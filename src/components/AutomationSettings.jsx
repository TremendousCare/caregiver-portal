import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { PHASES, DOCUMENT_TYPES } from '../lib/constants';
import { getPhaseTasks } from '../lib/storage';
import btn from '../styles/buttons.module.css';
import forms from '../styles/forms.module.css';
import cards from '../styles/cards.module.css';
import s from './AutomationSettings.module.css';

// ─── Trigger & Action Config ───
const TRIGGER_OPTIONS = [
  { value: 'new_caregiver', label: 'New Caregiver Added', description: 'Fires when a new caregiver is created' },
  { value: 'days_inactive', label: 'Days Inactive', description: 'Fires when a caregiver has no activity for N days' },
  { value: 'phase_change', label: 'Phase Changed', description: 'Fires when a caregiver moves to a new onboarding phase' },
  { value: 'task_completed', label: 'Task Completed', description: 'Fires when a specific onboarding task is marked complete' },
  { value: 'document_uploaded', label: 'Document Uploaded', description: 'Fires when a document is uploaded to SharePoint' },
  { value: 'document_signed', label: 'Document Signed', description: 'Fires when a DocuSign envelope is fully signed' },
  { value: 'interview_scheduled', label: 'Interview Scheduled', description: 'Coming soon', disabled: true },
];

const ACTION_OPTIONS = [
  { value: 'send_sms', label: 'Send SMS', description: 'Send a text message via RingCentral' },
  { value: 'send_email', label: 'Send Email', description: 'Send an email via Outlook' },
  { value: 'update_phase', label: 'Move to Phase', description: 'Move caregiver to a specific onboarding phase' },
  { value: 'complete_task', label: 'Complete Task', description: 'Mark a specific onboarding task as done' },
  { value: 'add_note', label: 'Add Note', description: 'Add a note to the caregiver record' },
  { value: 'update_field', label: 'Update Field', description: 'Change a caregiver field value' },
  { value: 'send_docusign_envelope', label: 'Send DocuSign Envelope', description: 'Send document(s) for eSignature via DocuSign' },
];

const MERGE_FIELDS = [
  { key: 'first_name', label: 'First Name' },
  { key: 'last_name', label: 'Last Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'phase', label: 'Phase ID' },
  { key: 'phase_name', label: 'Phase Name' },
  { key: 'days_in_phase', label: 'Days in Phase' },
  { key: 'overall_progress', label: 'Progress %' },
  { key: 'completed_task', label: 'Completed Task', triggers: ['task_completed'] },
  { key: 'document_type', label: 'Document Type', triggers: ['document_uploaded'] },
  { key: 'signed_documents', label: 'Signed Documents', triggers: ['document_signed'] },
];

// ─── Settings Section Card (reused from AdminSettings pattern) ───
function SettingsCard({ title, description, headerRight, children }) {
  return (
    <div className={cards.profileCard}>
      <div className={cards.profileCardHeader}>
        <div>
          <h3 className={cards.profileCardTitle}>{title}</h3>
          {description && (
            <span style={{ fontSize: 12, color: '#7A8BA0', fontWeight: 500 }}>{description}</span>
          )}
        </div>
        {headerRight}
      </div>
      <div style={{ padding: '20px 24px' }}>
        {children}
      </div>
    </div>
  );
}

// ─── Trigger Badge ───
function TriggerBadge({ type }) {
  const colors = {
    new_caregiver: { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' },
    days_inactive: { bg: '#FFFBEB', color: '#A16207', border: '#FDE68A' },
    interview_scheduled: { bg: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE' },
    phase_change: { bg: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE' },
    task_completed: { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' },
    document_uploaded: { bg: '#FFF7ED', color: '#C2410C', border: '#FED7AA' },
    document_signed: { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' },
  };
  const labels = {
    new_caregiver: 'New Caregiver',
    days_inactive: 'Days Inactive',
    interview_scheduled: 'Interview',
    phase_change: 'Phase Change',
    task_completed: 'Task Done',
    document_uploaded: 'Doc Upload',
    document_signed: 'Doc Signed',
  };
  const c = colors[type] || colors.new_caregiver;
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 6,
      fontSize: 11, fontWeight: 700, background: c.bg, color: c.color, border: `1px solid ${c.border}`,
    }}>
      {labels[type] || type}
    </span>
  );
}

// ─── Action Badge ───
function ActionBadge({ type }) {
  const config = {
    send_sms: { bg: '#F5F3FF', color: '#6D28D9', border: '#DDD6FE', label: 'SMS' },
    send_email: { bg: '#F0F4FA', color: '#2E4E8D', border: '#D5DCE6', label: 'Email' },
    update_phase: { bg: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE', label: 'Phase' },
    complete_task: { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0', label: 'Task' },
    add_note: { bg: '#FFFBEB', color: '#A16207', border: '#FDE68A', label: 'Note' },
    update_field: { bg: '#F8F9FB', color: '#4B5563', border: '#E0E4EA', label: 'Field' },
    send_docusign_envelope: { bg: '#F5F3FF', color: '#6D28D9', border: '#DDD6FE', label: 'DocuSign' },
  };
  const c = config[type] || config.send_sms;
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 6,
      fontSize: 11, fontWeight: 700, background: c.bg, color: c.color, border: `1px solid ${c.border}`,
    }}>
      {c.label}
    </span>
  );
}

// ─── Status Badge ───
function StatusBadge({ status }) {
  const config = {
    success: { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0', label: 'Success' },
    failed: { bg: '#FEF2F2', color: '#DC2626', border: '#FECACA', label: 'Failed' },
    skipped: { bg: '#F8F9FB', color: '#7A8BA0', border: '#E0E4EA', label: 'Skipped' },
  };
  const c = config[status] || config.skipped;
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 6,
      fontSize: 11, fontWeight: 700, background: c.bg, color: c.color, border: `1px solid ${c.border}`,
    }}>
      {c.label}
    </span>
  );
}

// ─── Rule Form Modal ───
function RuleForm({ rule, onSave, onCancel, saving }) {
  const [name, setName] = useState(rule?.name || '');
  const [triggerType, setTriggerType] = useState(rule?.trigger_type || 'new_caregiver');
  const [daysInactive, setDaysInactive] = useState(rule?.conditions?.days || 3);
  const [actionType, setActionType] = useState(rule?.action_type || 'send_sms');
  const [emailSubject, setEmailSubject] = useState(rule?.action_config?.subject || '');
  const [messageTemplate, setMessageTemplate] = useState(rule?.message_template || '');
  const [error, setError] = useState('');
  const templateRef = useRef(null);

  // New trigger-specific condition states
  const [toPhase, setToPhase] = useState(rule?.conditions?.to_phase || '');
  const [taskId, setTaskId] = useState(rule?.conditions?.task_id || '');
  const [documentType, setDocumentType] = useState(rule?.conditions?.document_type || '');
  const [phaseFilter, setPhaseFilter] = useState(rule?.conditions?.phase || '');

  // Document signed trigger condition
  const [templateNameFilter, setTemplateNameFilter] = useState(rule?.conditions?.template_name || '');

  // New action-specific config states
  const [targetPhase, setTargetPhase] = useState(rule?.action_config?.target_phase || '');
  const [actionTaskId, setActionTaskId] = useState(rule?.action_config?.task_id || '');
  const [fieldName, setFieldName] = useState(rule?.action_config?.field_name || '');
  const [fieldValue, setFieldValue] = useState(rule?.action_config?.field_value || '');
  const [docusignSendAll, setDocusignSendAll] = useState(rule?.action_config?.send_all ?? true);

  const insertMergeField = (field) => {
    const tag = `{{${field}}}`;
    const textarea = templateRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newVal = messageTemplate.substring(0, start) + tag + messageTemplate.substring(end);
      setMessageTemplate(newVal);
      // Reset cursor position after React re-renders
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + tag.length;
        textarea.focus();
      }, 0);
    } else {
      setMessageTemplate(messageTemplate + tag);
    }
  };

  const handleSave = () => {
    const isCommunicationAction = ['send_sms', 'send_email'].includes(actionType);
    const requiresMessage = isCommunicationAction || actionType === 'add_note';

    if (!name.trim()) { setError('Rule name is required.'); return; }
    if (requiresMessage && !messageTemplate.trim()) { setError('Message/note text is required.'); return; }
    if (triggerType === 'days_inactive' && (!daysInactive || daysInactive <= 0)) {
      setError('Days of inactivity must be a positive number.'); return;
    }
    if (actionType === 'send_email' && !emailSubject.trim()) { setError('Email subject is required.'); return; }
    if (actionType === 'update_phase' && !targetPhase) { setError('Select a target phase.'); return; }
    if (actionType === 'complete_task' && !actionTaskId) { setError('Select a task to complete.'); return; }
    if (actionType === 'update_field' && !fieldName) { setError('Select a field to update.'); return; }

    const ruleData = {
      name: name.trim(),
      trigger_type: triggerType,
      conditions: {
        ...(triggerType === 'days_inactive' ? { days: parseInt(daysInactive, 10) } : {}),
        ...(triggerType === 'phase_change' && toPhase ? { to_phase: toPhase } : {}),
        ...(triggerType === 'task_completed' && taskId ? { task_id: taskId } : {}),
        ...(triggerType === 'document_uploaded' && documentType ? { document_type: documentType } : {}),
        ...(triggerType === 'document_signed' && templateNameFilter.trim() ? { template_name: templateNameFilter.trim() } : {}),
        ...(phaseFilter ? { phase: phaseFilter } : {}),
      },
      action_type: actionType,
      action_config: {
        ...(actionType === 'send_email' ? { subject: emailSubject.trim() } : {}),
        ...(actionType === 'update_phase' ? { target_phase: targetPhase } : {}),
        ...(actionType === 'complete_task' ? { task_id: actionTaskId } : {}),
        ...(actionType === 'update_field' ? { field_name: fieldName, field_value: fieldValue } : {}),
        ...(actionType === 'send_docusign_envelope' ? { send_all: docusignSendAll } : {}),
      },
      message_template: messageTemplate.trim(),
    };

    if (rule?.id) ruleData.id = rule.id;
    onSave(ruleData);
  };

  return (
    <div className={s.formOverlay} onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className={s.formModal} style={{ maxWidth: 560 }}>
        <h3 className={cards.profileCardTitle} style={{ marginBottom: 20 }}>
          {rule?.id ? 'Edit Automation Rule' : 'Create Automation Rule'}
        </h3>

        {/* Rule Name */}
        <div style={{ marginBottom: 16 }}>
          <label className={forms.fieldLabel}>Rule Name</label>
          <input
            type="text"
            className={forms.fieldInput}
            style={{ borderColor: error && !name.trim() ? '#DC4A3A' : '#E0E4EA' }}
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            placeholder="e.g. Welcome SMS"
            autoFocus
          />
        </div>

        {/* Trigger Type */}
        <div style={{ marginBottom: 16 }}>
          <label className={forms.fieldLabel}>Trigger</label>
          <select
            className={forms.fieldInput}
            style={{ cursor: 'pointer' }}
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value)}
          >
            {TRIGGER_OPTIONS.map((t) => (
              <option key={t.value} value={t.value} disabled={t.disabled}>
                {t.label}{t.disabled ? ' (Coming soon)' : ''}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 4 }}>
            {TRIGGER_OPTIONS.find((t) => t.value === triggerType)?.description}
          </div>
        </div>

        {/* Conditions — days_inactive */}
        {triggerType === 'days_inactive' && (
          <div style={{ marginBottom: 16 }}>
            <label className={forms.fieldLabel}>Days of Inactivity</label>
            <input
              type="number"
              className={forms.fieldInput}
              style={{ maxWidth: 120 }}
              value={daysInactive}
              onChange={(e) => { setDaysInactive(e.target.value); setError(''); }}
              min="1"
              placeholder="3"
            />
            <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 4 }}>
              Fires when a caregiver has had no activity (notes, messages) for this many days.
            </div>
          </div>
        )}

        {/* Conditions — phase_change */}
        {triggerType === 'phase_change' && (
          <div style={{ marginBottom: 16 }}>
            <label className={forms.fieldLabel}>Target Phase (optional)</label>
            <select className={forms.fieldInput} style={{ cursor: 'pointer' }} value={toPhase} onChange={(e) => setToPhase(e.target.value)}>
              <option value="">Any phase change</option>
              {PHASES.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.label}</option>)}
            </select>
            <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 4 }}>
              Leave empty to fire on any phase change, or select a specific target phase.
            </div>
          </div>
        )}

        {/* Conditions — task_completed */}
        {triggerType === 'task_completed' && (
          <div style={{ marginBottom: 16 }}>
            <label className={forms.fieldLabel}>Specific Task (optional)</label>
            <select className={forms.fieldInput} style={{ cursor: 'pointer' }} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">Any task completed</option>
              {PHASES.map((phase) => {
                const tasks = getPhaseTasks()[phase.id] || [];
                return tasks.length > 0 ? (
                  <optgroup key={phase.id} label={`${phase.icon} ${phase.label}`}>
                    {tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </optgroup>
                ) : null;
              })}
            </select>
          </div>
        )}

        {/* Conditions — document_uploaded */}
        {triggerType === 'document_uploaded' && (
          <div style={{ marginBottom: 16 }}>
            <label className={forms.fieldLabel}>Document Type (optional)</label>
            <select className={forms.fieldInput} style={{ cursor: 'pointer' }} value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
              <option value="">Any document uploaded</option>
              {DOCUMENT_TYPES.map((dt) => <option key={dt.id} value={dt.id}>{dt.label}</option>)}
            </select>
          </div>
        )}

        {/* Conditions — document_signed */}
        {triggerType === 'document_signed' && (
          <div style={{ marginBottom: 16 }}>
            <label className={forms.fieldLabel}>Template Name Filter (optional)</label>
            <input
              type="text"
              className={forms.fieldInput}
              value={templateNameFilter}
              onChange={(e) => setTemplateNameFilter(e.target.value)}
              placeholder="e.g. Employment Agreement (leave empty for any)"
            />
            <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 4 }}>
              Only fire when the signed envelope contains a template with this name. Leave empty to fire on any signed document.
            </div>
          </div>
        )}

        {/* Universal phase filter — all trigger types */}
        <div style={{ marginBottom: 16 }}>
          <label className={forms.fieldLabel}>Only in Phase (optional)</label>
          <select className={forms.fieldInput} style={{ cursor: 'pointer' }} value={phaseFilter} onChange={(e) => setPhaseFilter(e.target.value)}>
            <option value="">Any phase</option>
            {PHASES.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.label}</option>)}
          </select>
          <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 4 }}>
            Restrict this rule to only fire when the caregiver is in a specific phase.
          </div>
        </div>

        {/* Action Type */}
        <div style={{ marginBottom: 16 }}>
          <label className={forms.fieldLabel}>Action</label>
          <select
            className={forms.fieldInput}
            style={{ cursor: 'pointer' }}
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
          >
            {ACTION_OPTIONS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
          {ACTION_OPTIONS.find((a) => a.value === actionType)?.description && (
            <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 4 }}>
              {ACTION_OPTIONS.find((a) => a.value === actionType)?.description}
            </div>
          )}
        </div>

        {/* Email Subject (only for email) */}
        {actionType === 'send_email' && (
          <div style={{ marginBottom: 16 }}>
            <label className={forms.fieldLabel}>Email Subject</label>
            <input
              type="text"
              className={forms.fieldInput}
              style={{ borderColor: error && actionType === 'send_email' && !emailSubject.trim() ? '#DC4A3A' : '#E0E4EA' }}
              value={emailSubject}
              onChange={(e) => { setEmailSubject(e.target.value); setError(''); }}
              placeholder="e.g. Welcome to Tremendous Care!"
            />
          </div>
        )}

        {/* Action config — update_phase */}
        {actionType === 'update_phase' && (
          <div style={{ marginBottom: 16 }}>
            <label className={forms.fieldLabel}>Move to Phase</label>
            <select className={forms.fieldInput} style={{ cursor: 'pointer' }} value={targetPhase} onChange={(e) => { setTargetPhase(e.target.value); setError(''); }}>
              <option value="">Select phase...</option>
              {PHASES.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.label}</option>)}
            </select>
          </div>
        )}

        {/* Action config — complete_task */}
        {actionType === 'complete_task' && (
          <div style={{ marginBottom: 16 }}>
            <label className={forms.fieldLabel}>Task to Complete</label>
            <select className={forms.fieldInput} style={{ cursor: 'pointer' }} value={actionTaskId} onChange={(e) => { setActionTaskId(e.target.value); setError(''); }}>
              <option value="">Select task...</option>
              {PHASES.map((phase) => {
                const tasks = getPhaseTasks()[phase.id] || [];
                return tasks.length > 0 ? (
                  <optgroup key={phase.id} label={`${phase.icon} ${phase.label}`}>
                    {tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </optgroup>
                ) : null;
              })}
            </select>
          </div>
        )}

        {/* Action config — update_field */}
        {actionType === 'update_field' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>Field to Update</label>
              <select className={forms.fieldInput} style={{ cursor: 'pointer' }} value={fieldName} onChange={(e) => { setFieldName(e.target.value); setError(''); }}>
                <option value="">Select field...</option>
                <option value="board_status">Board Status</option>
                <option value="board_note">Board Note</option>
                <option value="availability">Availability</option>
                <option value="preferred_shift">Preferred Shift</option>
              </select>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label className={forms.fieldLabel}>New Value</label>
              <input type="text" className={forms.fieldInput} value={fieldValue}
                onChange={(e) => { setFieldValue(e.target.value); setError(''); }}
                placeholder="e.g. ready" />
            </div>
          </>
        )}

        {/* Action config — send_docusign_envelope */}
        {actionType === 'send_docusign_envelope' && (
          <div style={{ marginBottom: 16 }}>
            <label className={forms.fieldLabel}>What to Send</label>
            <select className={forms.fieldInput} style={{ cursor: 'pointer' }} value={docusignSendAll ? 'all' : 'specific'} onChange={(e) => setDocusignSendAll(e.target.value === 'all')}>
              <option value="all">Full Onboarding Packet (all templates)</option>
              <option value="specific">Specific templates (configure in Settings)</option>
            </select>
            <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 4 }}>
              Templates are configured in Settings &gt; DocuSign eSignature.
            </div>
          </div>
        )}

        {/* Message Template */}
        <div style={{ marginBottom: 8 }}>
          <label className={forms.fieldLabel}>
            {actionType === 'add_note' ? 'Note Text'
             : ['update_phase', 'complete_task', 'update_field'].includes(actionType) ? 'Auto-Note Message (optional)'
             : 'Message Template'}
          </label>
          <textarea
            ref={templateRef}
            className={forms.textarea}
            style={{ minHeight: 100, borderColor: error && !messageTemplate.trim() && !['update_phase', 'complete_task', 'update_field'].includes(actionType) ? '#DC4A3A' : '#E0E4EA' }}
            value={messageTemplate}
            onChange={(e) => { setMessageTemplate(e.target.value); setError(''); }}
            placeholder={actionType === 'add_note'
              ? 'e.g. Automated note: caregiver reached {{phase_name}} phase'
              : ['update_phase', 'complete_task', 'update_field'].includes(actionType)
                ? 'Optional note to attach when this action runs'
                : `Hi {{first_name}}, welcome to Tremendous Care! We're excited to have you on board.`}
          />
        </div>

        {/* Merge Field Chips */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#7A8BA0', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
            Insert Merge Field
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {MERGE_FIELDS
              .filter(f => !f.triggers || f.triggers.includes(triggerType))
              .map((f) => (
              <button
                key={f.key}
                type="button"
                style={{
                  background: '#F0F4FA', border: '1px solid #D5DCE6', borderRadius: 6,
                  padding: '4px 10px', fontSize: 11, fontWeight: 600, color: '#2E4E8D',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
                onClick={() => insertMergeField(f.key)}
                onMouseEnter={(e) => { e.target.style.background = '#E0E8F5'; }}
                onMouseLeave={(e) => { e.target.style.background = '#F0F4FA'; }}
              >
                {`{{${f.key}}}`}
              </button>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{ fontSize: 12, color: '#DC4A3A', fontWeight: 600, marginBottom: 12 }}>{error}</div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            className={btn.secondaryBtn}
            style={{ padding: '9px 20px', fontSize: 13 }}
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className={btn.primaryBtn}
            style={{ padding: '9px 20px', fontSize: 13, opacity: saving ? 0.6 : 1 }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : rule?.id ? 'Update Rule' : 'Create Rule'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Rules List ───
function RulesList({ rules, onToggle, onEdit, onDelete, toggling }) {
  if (rules.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '32px 16px', color: '#7A8BA0', fontSize: 13 }}>
        No automation rules yet. Click "Add Rule" to create your first automation.
      </div>
    );
  }

  return (
    <div style={{ border: '1px solid #E0E4EA', borderRadius: 12, overflow: 'hidden' }}>
      {/* Header row */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 110px 80px 70px 130px',
        padding: '10px 16px', background: '#F8F9FB',
        fontSize: 10, fontWeight: 700, color: '#7A8BA0',
        textTransform: 'uppercase', letterSpacing: 1,
        borderBottom: '1px solid #E0E4EA',
      }}>
        <span>Rule</span>
        <span>Trigger</span>
        <span>Action</span>
        <span>Status</span>
        <span style={{ textAlign: 'right' }}>Actions</span>
      </div>

      {rules.map((rule, i) => (
        <div key={rule.id} style={{
          display: 'grid', gridTemplateColumns: '1fr 110px 80px 70px 130px',
          alignItems: 'center', padding: '12px 16px',
          borderBottom: i < rules.length - 1 ? '1px solid #F0F3F7' : 'none',
          background: '#fff',
        }}>
          {/* Name + condition detail */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#0F1724' }}>{rule.name}</div>
            {rule.trigger_type === 'days_inactive' && rule.conditions?.days && (
              <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 2 }}>
                After {rule.conditions.days} day{rule.conditions.days !== 1 ? 's' : ''}
              </div>
            )}
            {rule.trigger_type === 'phase_change' && rule.conditions?.to_phase && (
              <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 2 }}>
                When entering: {PHASES.find(p => p.id === rule.conditions.to_phase)?.label || rule.conditions.to_phase}
              </div>
            )}
            {rule.trigger_type === 'task_completed' && rule.conditions?.task_id && (
              <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 2 }}>
                Task: {rule.conditions.task_id}
              </div>
            )}
            {rule.trigger_type === 'document_uploaded' && rule.conditions?.document_type && (
              <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 2 }}>
                Doc: {DOCUMENT_TYPES.find(d => d.id === rule.conditions.document_type)?.label || rule.conditions.document_type}
              </div>
            )}
            {rule.trigger_type === 'document_signed' && rule.conditions?.template_name && (
              <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 2 }}>
                Template: {rule.conditions.template_name}
              </div>
            )}
            {rule.conditions?.phase && (
              <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 2 }}>
                Only in: {PHASES.find(p => p.id === rule.conditions.phase)?.label || rule.conditions.phase}
              </div>
            )}
            {/* Action details for mutation actions */}
            {rule.action_type === 'update_phase' && rule.action_config?.target_phase && (
              <div style={{ fontSize: 11, color: '#1D4ED8', marginTop: 2 }}>
                &rarr; {PHASES.find(p => p.id === rule.action_config.target_phase)?.label || rule.action_config.target_phase}
              </div>
            )}
            {rule.action_type === 'complete_task' && rule.action_config?.task_id && (
              <div style={{ fontSize: 11, color: '#15803D', marginTop: 2 }}>
                &rarr; {rule.action_config.task_id}
              </div>
            )}
            {rule.action_type === 'send_docusign_envelope' && (
              <div style={{ fontSize: 11, color: '#6D28D9', marginTop: 2 }}>
                &rarr; {rule.action_config?.send_all !== false ? 'Full Packet' : 'Specific templates'}
              </div>
            )}
          </div>

          {/* Trigger badge */}
          <div><TriggerBadge type={rule.trigger_type} /></div>

          {/* Action badge */}
          <div><ActionBadge type={rule.action_type} /></div>

          {/* Enabled toggle */}
          <div>
            <button
              style={{
                width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
                background: rule.enabled ? '#22C55E' : '#D5DCE6',
                position: 'relative', transition: 'background 0.2s',
                opacity: toggling === rule.id ? 0.5 : 1,
              }}
              onClick={() => onToggle(rule)}
              disabled={toggling === rule.id}
              title={rule.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
            >
              <div style={{
                width: 16, height: 16, borderRadius: '50%', background: '#fff',
                position: 'absolute', top: 3,
                left: rule.enabled ? 21 : 3,
                transition: 'left 0.2s',
                boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
              }} />
            </button>
          </div>

          {/* Edit / Delete buttons */}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              className={btn.editBtn}
              style={{ padding: '5px 12px', fontSize: 11 }}
              onClick={() => onEdit(rule)}
              onMouseEnter={(e) => { e.target.style.background = '#F0F4FA'; }}
              onMouseLeave={(e) => { e.target.style.background = '#fff'; }}
            >
              Edit
            </button>
            <button
              className={btn.editBtn}
              style={{
                padding: '5px 12px', fontSize: 11,
                color: '#DC4A3A', borderColor: '#FECACA',
              }}
              onClick={() => onDelete(rule)}
              onMouseEnter={(e) => { e.target.style.background = '#FEF2F2'; }}
              onMouseLeave={(e) => { e.target.style.background = '#fff'; }}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Execution Log ───
function ExecutionLog({ logs, loading, collapsed, onToggleCollapse }) {
  const formatTimestamp = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 7) return `${diffDays}d ago`;

    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  if (loading) {
    return <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>;
  }

  if (logs.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 16px', color: '#7A8BA0', fontSize: 13 }}>
        No automations have fired yet. Create a rule above to get started.
      </div>
    );
  }

  return (
    <>
      {/* Collapse / Expand toggle */}
      <button
        className={s.logToggleBtn}
        onClick={onToggleCollapse}
      >
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
        >
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{collapsed ? 'Show' : 'Hide'} log entries</span>
        <span className={s.logCountBadge}>{logs.length}</span>
      </button>

      {!collapsed && (
        <div className={s.logScrollContainer}>
          <div style={{ border: '1px solid #E0E4EA', borderRadius: 12, overflow: 'hidden' }}>
            {/* Header */}
            <div style={{
              display: 'grid', gridTemplateColumns: '100px 1fr 1fr 70px 70px',
              padding: '10px 16px', background: '#F8F9FB',
              fontSize: 10, fontWeight: 700, color: '#7A8BA0',
              textTransform: 'uppercase', letterSpacing: 1,
              borderBottom: '1px solid #E0E4EA',
              position: 'sticky', top: 0, zIndex: 1,
            }}>
              <span>Time</span>
              <span>Rule</span>
              <span>Caregiver</span>
              <span>Action</span>
              <span>Status</span>
            </div>

            {logs.map((log, i) => (
              <div key={log.id} style={{
                display: 'grid', gridTemplateColumns: '100px 1fr 1fr 70px 70px',
                alignItems: 'center', padding: '10px 16px',
                borderBottom: i < logs.length - 1 ? '1px solid #F0F3F7' : 'none',
                background: '#fff',
              }}>
                <div style={{ fontSize: 11, color: '#7A8BA0', fontWeight: 500 }}>
                  {formatTimestamp(log.executed_at)}
                </div>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#0F1724', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {log.rule_name || log.rule_id}
                </div>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#0F1724', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {log.caregiver_name || log.caregiver_id}
                </div>
                <div><ActionBadge type={log.action_type} /></div>
                <div>
                  <StatusBadge status={log.status} />
                  {log.error_detail && (
                    <div style={{ fontSize: 10, color: '#DC2626', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={log.error_detail}
                    >
                      {log.error_detail}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Main AutomationSettings Component ───
export function AutomationSettings({ showToast, currentUserEmail }) {
  const [rules, setRules] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loadingRules, setLoadingRules] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(null);
  const [logCollapsed, setLogCollapsed] = useState(true);

  // Load rules
  const loadRules = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('automation_rules')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setRules(data || []);
    } catch (err) {
      console.error('Failed to load automation rules:', err);
    } finally {
      setLoadingRules(false);
    }
  }, []);

  // Load logs with rule names and caregiver names
  const loadLogs = useCallback(async () => {
    try {
      const { data: logData, error: logErr } = await supabase
        .from('automation_log')
        .select('*')
        .order('executed_at', { ascending: false })
        .limit(50);
      if (logErr) throw logErr;

      if (!logData || logData.length === 0) {
        setLogs([]);
        setLoadingLogs(false);
        return;
      }

      // Fetch rule names
      const ruleIds = [...new Set(logData.map((l) => l.rule_id))];
      const { data: rulesData } = await supabase
        .from('automation_rules')
        .select('id, name')
        .in('id', ruleIds);
      const ruleMap = {};
      (rulesData || []).forEach((r) => { ruleMap[r.id] = r.name; });

      // Fetch caregiver names
      const cgIds = [...new Set(logData.map((l) => l.caregiver_id))];
      const { data: cgData } = await supabase
        .from('caregivers')
        .select('id, first_name, last_name')
        .in('id', cgIds);
      const cgMap = {};
      (cgData || []).forEach((c) => { cgMap[c.id] = `${c.first_name} ${c.last_name}`; });

      // Enrich logs
      const enriched = logData.map((l) => ({
        ...l,
        rule_name: ruleMap[l.rule_id] || null,
        caregiver_name: cgMap[l.caregiver_id] || null,
      }));

      setLogs(enriched);
    } catch (err) {
      console.error('Failed to load automation logs:', err);
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  useEffect(() => { loadRules(); loadLogs(); }, [loadRules, loadLogs]);

  // Toggle rule enabled/disabled
  const handleToggle = useCallback(async (rule) => {
    setToggling(rule.id);
    try {
      const { error } = await supabase
        .from('automation_rules')
        .update({
          enabled: !rule.enabled,
          updated_at: new Date().toISOString(),
          updated_by: currentUserEmail,
        })
        .eq('id', rule.id);
      if (error) throw error;
      setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled: !r.enabled } : r));
      showToast?.(`${rule.name} ${!rule.enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      console.error('Failed to toggle rule:', err);
      showToast?.('Failed to update rule. Please try again.');
    } finally {
      setToggling(null);
    }
  }, [currentUserEmail, showToast]);

  // Save rule (create or update)
  const handleSave = useCallback(async (ruleData) => {
    setSaving(true);
    try {
      const payload = {
        ...ruleData,
        updated_at: new Date().toISOString(),
        updated_by: currentUserEmail,
      };

      if (ruleData.id) {
        // Update
        const { error } = await supabase
          .from('automation_rules')
          .update(payload)
          .eq('id', ruleData.id);
        if (error) throw error;
        showToast?.(`${ruleData.name} updated`);
      } else {
        // Create
        payload.created_by = currentUserEmail;
        const { error } = await supabase
          .from('automation_rules')
          .insert(payload);
        if (error) throw error;
        showToast?.(`${ruleData.name} created`);
      }

      setShowForm(false);
      setEditingRule(null);
      await loadRules();
    } catch (err) {
      console.error('Failed to save rule:', err);
      showToast?.('Failed to save rule. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [currentUserEmail, showToast, loadRules]);

  // Delete rule
  const handleDelete = useCallback(async (rule) => {
    if (!window.confirm(`Are you sure you want to delete "${rule.name}"? This cannot be undone.`)) return;

    try {
      const { error } = await supabase
        .from('automation_rules')
        .delete()
        .eq('id', rule.id);
      if (error) throw error;
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      showToast?.(`${rule.name} deleted`);
    } catch (err) {
      console.error('Failed to delete rule:', err);
      showToast?.('Failed to delete rule. Please try again.');
    }
  }, [showToast]);

  // Edit rule
  const handleEdit = useCallback((rule) => {
    setEditingRule(rule);
    setShowForm(true);
  }, []);

  // Open create form
  const handleCreate = useCallback(() => {
    setEditingRule(null);
    setShowForm(true);
  }, []);

  if (loadingRules) {
    return (
      <SettingsCard title="Automation Rules" description="Automated Actions">
        <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>
      </SettingsCard>
    );
  }

  return (
    <>
      {/* Rules Section */}
      <SettingsCard
        title="Automation Rules"
        description={`${rules.length} rule${rules.length !== 1 ? 's' : ''}`}
        headerRight={
          <button
            className={btn.primaryBtn}
            style={{ padding: '8px 18px', fontSize: 13 }}
            onClick={handleCreate}
          >
            Add Rule
          </button>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: '#7A8BA0', lineHeight: 1.5 }}>
            Automation rules execute actions automatically when triggers fire. Configure triggers (new caregiver, days inactive, phase change, task completion, document upload, document signed) with actions (SMS, email, phase move, task completion, notes, field updates, DocuSign envelopes).
          </div>
        </div>

        <RulesList
          rules={rules}
          onToggle={handleToggle}
          onEdit={handleEdit}
          onDelete={handleDelete}
          toggling={toggling}
        />
      </SettingsCard>

      {/* Execution Log */}
      <div style={{ marginTop: 20 }}>
        <SettingsCard title="Execution Log" description="Recent automation activity">
          <ExecutionLog
            logs={logs}
            loading={loadingLogs}
            collapsed={logCollapsed}
            onToggleCollapse={() => setLogCollapsed((prev) => !prev)}
          />
        </SettingsCard>
      </div>

      {/* Rule Form Modal */}
      {showForm && (
        <RuleForm
          rule={editingRule}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditingRule(null); }}
          saving={saving}
        />
      )}
    </>
  );
}
