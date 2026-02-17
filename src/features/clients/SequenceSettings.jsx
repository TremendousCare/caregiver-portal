import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { CLIENT_PHASES } from './constants';
import btn from '../../styles/buttons.module.css';
import forms from '../../styles/forms.module.css';
import cards from '../../styles/cards.module.css';

// ─── Config ───

const ACTION_TYPE_OPTIONS = [
  { value: 'send_sms', label: 'Send SMS', description: 'Send a text message via RingCentral' },
  { value: 'send_email', label: 'Send Email', description: 'Send an email via Outlook' },
  { value: 'create_task', label: 'Create Follow-up Task', description: 'Add a task to the client checklist' },
];

const MERGE_FIELDS = [
  { key: 'first_name', label: 'First Name' },
  { key: 'last_name', label: 'Last Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'care_recipient_name', label: 'Care Recipient' },
  { key: 'care_needs', label: 'Care Needs' },
  { key: 'phase', label: 'Phase' },
  { key: 'company_name', label: 'Company Name' },
];

const DELAY_UNITS = [
  { value: 'minutes', label: 'Minutes', multiplier: 1 / 60 },
  { value: 'hours', label: 'Hours', multiplier: 1 },
  { value: 'days', label: 'Days', multiplier: 24 },
];

// Convert delay_hours to a user-friendly value + unit
function decomposeDelay(delayHours) {
  if (delayHours === 0) return { value: 0, unit: 'minutes' };
  if (delayHours % 24 === 0) return { value: delayHours / 24, unit: 'days' };
  if (delayHours >= 1 && delayHours % 1 === 0) return { value: delayHours, unit: 'hours' };
  // Sub-hour: convert to minutes
  return { value: Math.round(delayHours * 60), unit: 'minutes' };
}

// Convert value + unit back to delay_hours
function composeDelay(value, unit) {
  const unitConfig = DELAY_UNITS.find((u) => u.value === unit);
  return (parseFloat(value) || 0) * (unitConfig?.multiplier || 1);
}

// ─── Settings Section Card (reused from AutomationSettings pattern) ───
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

// ─── Phase Badge ───
function PhaseBadge({ phaseId }) {
  const phase = CLIENT_PHASES.find((p) => p.id === phaseId);
  if (!phase) {
    return (
      <span style={{
        display: 'inline-block', padding: '3px 10px', borderRadius: 6,
        fontSize: 11, fontWeight: 700, background: '#F8F9FB', color: '#7A8BA0', border: '1px solid #E0E4EA',
      }}>
        Manual Only
      </span>
    );
  }
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 6,
      fontSize: 11, fontWeight: 700, background: `${phase.color}15`, color: phase.color,
      border: `1px solid ${phase.color}40`,
    }}>
      {phase.icon} {phase.short}
    </span>
  );
}

// ─── Action Type Badge ───
function ActionTypeBadge({ type }) {
  const config = {
    send_sms: { bg: '#F5F3FF', color: '#6D28D9', border: '#DDD6FE', label: 'SMS' },
    send_email: { bg: '#F0F4FA', color: '#2E4E8D', border: '#D5DCE6', label: 'Email' },
    create_task: { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0', label: 'Task' },
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

// ─── Step Editor Row ───
function StepRow({ step, index, onChange, onRemove, totalSteps }) {
  const templateRef = useRef(null);
  const { value: delayValue, unit: delayUnit } = decomposeDelay(step.delay_hours || 0);

  const handleDelayChange = (newValue, newUnit) => {
    const val = newValue !== undefined ? newValue : delayValue;
    const unit = newUnit !== undefined ? newUnit : delayUnit;
    onChange({ ...step, delay_hours: composeDelay(val, unit) });
  };

  const insertMergeField = (field) => {
    const tag = `{{${field}}}`;
    const textarea = templateRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newVal = step.template.substring(0, start) + tag + step.template.substring(end);
      onChange({ ...step, template: newVal });
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + tag.length;
        textarea.focus();
      }, 0);
    } else {
      onChange({ ...step, template: (step.template || '') + tag });
    }
  };

  return (
    <div style={{
      border: '1px solid #E0E4EA', borderRadius: 12, padding: 16, marginBottom: 12,
      background: '#FAFBFC', position: 'relative',
    }}>
      {/* Step header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, borderRadius: '50%',
            background: 'linear-gradient(135deg, #2E4E8D, #1084C3)', color: '#fff',
            fontSize: 12, fontWeight: 700,
          }}>
            {index + 1}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#0F1724' }}>
            Step {index + 1}
          </span>
        </div>
        {totalSteps > 1 && (
          <button
            type="button"
            style={{
              background: 'none', border: '1px solid #FECACA', borderRadius: 6,
              padding: '3px 8px', fontSize: 12, fontWeight: 600, color: '#DC4A3A',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
            onClick={onRemove}
            onMouseEnter={(e) => { e.target.style.background = '#FEF2F2'; }}
            onMouseLeave={(e) => { e.target.style.background = 'none'; }}
          >
            Remove
          </button>
        )}
      </div>

      {/* Delay + Action Type row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 1fr', gap: 10, marginBottom: 12 }}>
        {/* Delay value */}
        <div>
          <label className={forms.fieldLabel}>Delay</label>
          <input
            type="number"
            className={forms.fieldInput}
            value={delayValue}
            min="0"
            onChange={(e) => handleDelayChange(e.target.value, undefined)}
            placeholder="0"
          />
        </div>
        {/* Delay unit */}
        <div>
          <label className={forms.fieldLabel}>Unit</label>
          <select
            className={forms.fieldInput}
            style={{ cursor: 'pointer' }}
            value={delayUnit}
            onChange={(e) => handleDelayChange(undefined, e.target.value)}
          >
            {DELAY_UNITS.map((u) => (
              <option key={u.value} value={u.value}>{u.label}</option>
            ))}
          </select>
        </div>
        {/* Action type */}
        <div>
          <label className={forms.fieldLabel}>Action</label>
          <select
            className={forms.fieldInput}
            style={{ cursor: 'pointer' }}
            value={step.action_type}
            onChange={(e) => onChange({ ...step, action_type: e.target.value })}
          >
            {ACTION_TYPE_OPTIONS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Email Subject (only for send_email) */}
      {step.action_type === 'send_email' && (
        <div style={{ marginBottom: 12 }}>
          <label className={forms.fieldLabel}>Subject</label>
          <input
            type="text"
            className={forms.fieldInput}
            value={step.subject || ''}
            onChange={(e) => onChange({ ...step, subject: e.target.value })}
            placeholder="e.g. Following up on your care needs"
          />
        </div>
      )}

      {/* Template */}
      <div style={{ marginBottom: 8 }}>
        <label className={forms.fieldLabel}>
          {step.action_type === 'create_task' ? 'Task Description' : 'Message Template'}
        </label>
        <textarea
          ref={templateRef}
          className={forms.textarea}
          style={{ minHeight: 80 }}
          value={step.template || ''}
          onChange={(e) => onChange({ ...step, template: e.target.value })}
          placeholder={
            step.action_type === 'create_task'
              ? 'e.g. Follow up with {{first_name}} about care plan'
              : 'Hi {{first_name}}, ...'
          }
        />
      </div>

      {/* Merge Field Chips (only for sms/email) */}
      {step.action_type !== 'create_task' && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#7A8BA0', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
            Insert Merge Field
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {MERGE_FIELDS.map((f) => (
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
      )}
    </div>
  );
}

// ─── Sequence Form Modal ───
function SequenceForm({ sequence, onSave, onCancel, saving }) {
  const [name, setName] = useState(sequence?.name || '');
  const [description, setDescription] = useState(sequence?.description || '');
  const [triggerPhase, setTriggerPhase] = useState(sequence?.trigger_phase || '');
  const [steps, setSteps] = useState(() => {
    if (sequence?.steps && sequence.steps.length > 0) return sequence.steps;
    return [{ step_id: 'step_1', delay_hours: 0, action_type: 'send_sms', template: '', subject: '' }];
  });
  const [error, setError] = useState('');

  const addStep = () => {
    const newId = `step_${Date.now()}`;
    setSteps([...steps, { step_id: newId, delay_hours: 24, action_type: 'send_sms', template: '', subject: '' }]);
  };

  const updateStep = (index, updatedStep) => {
    const newSteps = [...steps];
    newSteps[index] = updatedStep;
    setSteps(newSteps);
  };

  const removeStep = (index) => {
    setSteps(steps.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    if (!name.trim()) { setError('Sequence name is required.'); return; }
    if (steps.length === 0) { setError('At least one step is required.'); return; }

    // Validate each step
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step.template?.trim()) {
        setError(`Step ${i + 1}: ${step.action_type === 'create_task' ? 'Task description' : 'Message template'} is required.`);
        return;
      }
      if (step.action_type === 'send_email' && !step.subject?.trim()) {
        setError(`Step ${i + 1}: Email subject is required.`);
        return;
      }
    }

    const data = {
      name: name.trim(),
      description: description.trim(),
      trigger_phase: triggerPhase || null,
      steps,
    };

    if (sequence?.id) data.id = sequence.id;
    onSave(data);
  };

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(26,26,26,0.6)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', zIndex: 9999, padding: 24, backdropFilter: 'blur(3px)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={{
        background: '#fff', borderRadius: 16, padding: '28px 28px',
        width: '100%', maxWidth: 620, maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      }}>
        <h3 className={cards.profileCardTitle} style={{ marginBottom: 20 }}>
          {sequence?.id ? 'Edit Sequence' : 'Create Sequence'}
        </h3>

        {/* Name */}
        <div style={{ marginBottom: 16 }}>
          <label className={forms.fieldLabel}>Sequence Name</label>
          <input
            type="text"
            className={forms.fieldInput}
            style={{ borderColor: error && !name.trim() ? '#DC4A3A' : '#E0E4EA' }}
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            placeholder="e.g. New Lead Welcome Drip"
            autoFocus
          />
        </div>

        {/* Description */}
        <div style={{ marginBottom: 16 }}>
          <label className={forms.fieldLabel}>Description (optional)</label>
          <textarea
            className={forms.textarea}
            style={{ minHeight: 60 }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Briefly describe what this sequence does..."
          />
        </div>

        {/* Trigger Phase */}
        <div style={{ marginBottom: 20 }}>
          <label className={forms.fieldLabel}>Trigger Phase</label>
          <select
            className={forms.fieldInput}
            style={{ cursor: 'pointer' }}
            value={triggerPhase}
            onChange={(e) => setTriggerPhase(e.target.value)}
          >
            <option value="">Manual Only</option>
            {CLIENT_PHASES.map((p) => (
              <option key={p.id} value={p.id}>{p.icon} {p.label}</option>
            ))}
          </select>
          <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 4 }}>
            When a client enters this phase, they auto-enroll in this sequence. Choose "Manual Only" to trigger it manually.
          </div>
        </div>

        {/* Steps Section */}
        <div style={{ marginBottom: 16 }}>
          <div style={{
            fontSize: 13, fontWeight: 700, color: '#2E4E8D', textTransform: 'uppercase',
            letterSpacing: 1.2, marginBottom: 12, fontFamily: 'var(--tc-font-heading)',
            borderBottom: '2px solid #EDF0F4', paddingBottom: 10,
          }}>
            Steps
          </div>

          {steps.map((step, i) => (
            <StepRow
              key={step.step_id}
              step={step}
              index={i}
              totalSteps={steps.length}
              onChange={(updated) => updateStep(i, updated)}
              onRemove={() => removeStep(i)}
            />
          ))}

          <button
            type="button"
            className={btn.secondaryBtn}
            style={{ padding: '8px 16px', fontSize: 12, width: '100%', textAlign: 'center' }}
            onClick={addStep}
          >
            + Add Step
          </button>
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
            {saving ? 'Saving...' : sequence?.id ? 'Update Sequence' : 'Create Sequence'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sequence List ───
function SequenceList({ sequences, onToggle, onEdit, onDelete, toggling }) {
  if (sequences.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '32px 16px', color: '#7A8BA0', fontSize: 13 }}>
        No sequences yet. Click "Add Sequence" to create your first communication sequence.
      </div>
    );
  }

  return (
    <div style={{ border: '1px solid #E0E4EA', borderRadius: 12, overflow: 'hidden' }}>
      {/* Header row */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 110px 60px 70px 130px',
        padding: '10px 16px', background: '#F8F9FB',
        fontSize: 10, fontWeight: 700, color: '#7A8BA0',
        textTransform: 'uppercase', letterSpacing: 1,
        borderBottom: '1px solid #E0E4EA',
      }}>
        <span>Sequence</span>
        <span>Trigger</span>
        <span>Steps</span>
        <span>Status</span>
        <span style={{ textAlign: 'right' }}>Actions</span>
      </div>

      {sequences.map((seq, i) => (
        <div key={seq.id} style={{
          display: 'grid', gridTemplateColumns: '1fr 110px 60px 70px 130px',
          alignItems: 'center', padding: '12px 16px',
          borderBottom: i < sequences.length - 1 ? '1px solid #F0F3F7' : 'none',
          background: '#fff', cursor: 'pointer',
        }}
          onClick={() => onEdit(seq)}
        >
          {/* Name + description */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#0F1724' }}>{seq.name}</div>
            {seq.description && (
              <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                {seq.description}
              </div>
            )}
            {/* Step summary badges */}
            <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
              {(seq.steps || []).map((step, si) => (
                <ActionTypeBadge key={step.step_id || si} type={step.action_type} />
              ))}
            </div>
          </div>

          {/* Trigger phase badge */}
          <div><PhaseBadge phaseId={seq.trigger_phase} /></div>

          {/* Step count */}
          <div>
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 24, height: 22, borderRadius: 11,
              background: '#F0F4FA', color: '#2E4E8D', fontSize: 12, fontWeight: 700,
              padding: '0 6px',
            }}>
              {(seq.steps || []).length}
            </span>
          </div>

          {/* Enabled toggle */}
          <div>
            <button
              style={{
                width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
                background: seq.enabled ? '#22C55E' : '#D5DCE6',
                position: 'relative', transition: 'background 0.2s',
                opacity: toggling === seq.id ? 0.5 : 1,
              }}
              onClick={(e) => { e.stopPropagation(); onToggle(seq); }}
              disabled={toggling === seq.id}
              title={seq.enabled ? 'Enabled -- click to disable' : 'Disabled -- click to enable'}
            >
              <div style={{
                width: 16, height: 16, borderRadius: '50%', background: '#fff',
                position: 'absolute', top: 3,
                left: seq.enabled ? 21 : 3,
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
              onClick={(e) => { e.stopPropagation(); onEdit(seq); }}
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
              onClick={(e) => { e.stopPropagation(); onDelete(seq); }}
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

// ─── Main SequenceSettings Component ───
export function SequenceSettings({ showToast, currentUserEmail }) {
  const [sequences, setSequences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingSequence, setEditingSequence] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(null);

  // Load sequences
  const loadSequences = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('client_sequences')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setSequences(data || []);
    } catch (err) {
      console.error('Failed to load sequences:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSequences(); }, [loadSequences]);

  // Toggle sequence enabled/disabled
  const handleToggle = useCallback(async (seq) => {
    setToggling(seq.id);
    try {
      const { error } = await supabase
        .from('client_sequences')
        .update({
          enabled: !seq.enabled,
          updated_at: new Date().toISOString(),
          updated_by: currentUserEmail,
        })
        .eq('id', seq.id);
      if (error) throw error;
      setSequences((prev) => prev.map((s) => s.id === seq.id ? { ...s, enabled: !s.enabled } : s));
      showToast?.(`${seq.name} ${!seq.enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      console.error('Failed to toggle sequence:', err);
      showToast?.('Failed to update sequence. Please try again.');
    } finally {
      setToggling(null);
    }
  }, [currentUserEmail, showToast]);

  // Save sequence (create or update)
  const handleSave = useCallback(async (seqData) => {
    setSaving(true);
    try {
      const payload = {
        ...seqData,
        updated_at: new Date().toISOString(),
        updated_by: currentUserEmail,
      };

      if (seqData.id) {
        // Update existing
        const { error } = await supabase
          .from('client_sequences')
          .update(payload)
          .eq('id', seqData.id);
        if (error) throw error;
        showToast?.(`${seqData.name} updated`);
      } else {
        // Create new
        payload.created_by = currentUserEmail;
        payload.enabled = true;
        const { error } = await supabase
          .from('client_sequences')
          .insert(payload);
        if (error) throw error;
        showToast?.(`${seqData.name} created`);
      }

      setShowForm(false);
      setEditingSequence(null);
      await loadSequences();
    } catch (err) {
      console.error('Failed to save sequence:', err);
      showToast?.('Failed to save sequence. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [currentUserEmail, showToast, loadSequences]);

  // Delete sequence
  const handleDelete = useCallback(async (seq) => {
    if (!window.confirm(`Are you sure you want to delete "${seq.name}"? This cannot be undone.`)) return;

    try {
      const { error } = await supabase
        .from('client_sequences')
        .delete()
        .eq('id', seq.id);
      if (error) throw error;
      setSequences((prev) => prev.filter((s) => s.id !== seq.id));
      showToast?.(`${seq.name} deleted`);
    } catch (err) {
      console.error('Failed to delete sequence:', err);
      showToast?.('Failed to delete sequence. Please try again.');
    }
  }, [showToast]);

  // Edit sequence
  const handleEdit = useCallback((seq) => {
    setEditingSequence(seq);
    setShowForm(true);
  }, []);

  // Open create form
  const handleCreate = useCallback(() => {
    setEditingSequence(null);
    setShowForm(true);
  }, []);

  if (loading) {
    return (
      <SettingsCard title="Communication Sequences" description="Automated multi-step messaging flows">
        <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>
      </SettingsCard>
    );
  }

  return (
    <>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{
          fontSize: 26, fontWeight: 800, color: '#0F1724', marginBottom: 4,
          fontFamily: 'var(--tc-font-heading)', letterSpacing: '-0.5px',
        }}>
          Communication Sequences
        </h1>
        <p style={{ fontSize: 14, color: '#7A8BA0', fontWeight: 500, margin: 0 }}>
          Configure automated multi-step messaging flows for client leads
        </p>
      </div>

      {/* Sequences Section */}
      <SettingsCard
        title="Sequences"
        description={`${sequences.length} sequence${sequences.length !== 1 ? 's' : ''}`}
        headerRight={
          <button
            className={btn.primaryBtn}
            style={{ padding: '8px 18px', fontSize: 13 }}
            onClick={handleCreate}
          >
            Add Sequence
          </button>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: '#7A8BA0', lineHeight: 1.5 }}>
            Sequences are multi-step communication flows that execute automatically when a client enters a specific pipeline phase.
            Each step can send an SMS, email, or create a follow-up task with configurable delays between steps.
          </div>
        </div>

        <SequenceList
          sequences={sequences}
          onToggle={handleToggle}
          onEdit={handleEdit}
          onDelete={handleDelete}
          toggling={toggling}
        />
      </SettingsCard>

      {/* Sequence Form Modal */}
      {showForm && (
        <SequenceForm
          sequence={editingSequence}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditingSequence(null); }}
          saving={saving}
        />
      )}
    </>
  );
}
