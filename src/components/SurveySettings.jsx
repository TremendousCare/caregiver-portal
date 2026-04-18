import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import {
  QUESTION_TYPES, QUALIFICATION_ACTIONS, PROFILE_FIELD_OPTIONS, createBlankQuestion,
  generateQuestionId, getDefaultOptions, hasOptions, isStructuredQuestion, buildSurveyUrl,
} from '../lib/surveyUtils';
import btn from '../styles/buttons.module.css';
import forms from '../styles/forms.module.css';
import cards from '../styles/cards.module.css';
import { CollapsibleCard } from '../shared/components/CollapsibleCard';

// ═══════════════════════════════════════════════════════════════
// Survey Settings — Survey Builder UI
//
// Manages survey templates: create, edit, enable/disable.
// Each template has customizable questions with qualification
// rules (pass/flag/disqualify) configured inline per question.
// ═══════════════════════════════════════════════════════════════

// ─── Status Badge ───
function SurveyStatusBadge({ enabled }) {
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 6,
      fontSize: 11, fontWeight: 700,
      background: enabled ? '#F0FDF4' : '#F8F9FB',
      color: enabled ? '#15803D' : '#7A8BA0',
      border: `1px solid ${enabled ? '#BBF7D0' : '#E0E4EA'}`,
    }}>
      {enabled ? 'Active' : 'Inactive'}
    </span>
  );
}

// ─── Qualification Action Badge ───
function QualBadge({ action }) {
  const config = QUALIFICATION_ACTIONS.find((a) => a.value === action) || QUALIFICATION_ACTIONS[0];
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 5,
      fontSize: 10, fontWeight: 700,
      background: config.bg, color: config.color, border: `1px solid ${config.border}`,
    }}>
      {config.label}
    </span>
  );
}

// ─── Question Editor ───
function QuestionEditor({ question, index, onChange, onRemove, onMoveUp, onMoveDown, isFirst, isLast }) {
  const updateField = (field, value) => {
    onChange({ ...question, [field]: value });
  };

  const updateOption = (optIndex, value) => {
    const newOptions = [...(question.options || [])];
    newOptions[optIndex] = value;
    updateField('options', newOptions);
  };

  const addOption = () => {
    updateField('options', [...(question.options || []), `Option ${(question.options || []).length + 1}`]);
  };

  const removeOption = (optIndex) => {
    const newOptions = (question.options || []).filter((_, i) => i !== optIndex);
    // Also remove any qualification rules referencing the removed option
    const removedValue = question.options[optIndex];
    const newRules = (question.qualification_rules || []).filter((r) => r.answer !== removedValue);
    onChange({ ...question, options: newOptions, qualification_rules: newRules });
  };

  const updateRule = (ruleIndex, field, value) => {
    const newRules = [...(question.qualification_rules || [])];
    newRules[ruleIndex] = { ...newRules[ruleIndex], [field]: value };
    onChange({ ...question, qualification_rules: newRules });
  };

  const addRule = () => {
    const newRule = { answer: '', action: 'pass', reason: '' };
    onChange({ ...question, qualification_rules: [...(question.qualification_rules || []), newRule] });
  };

  const removeRule = (ruleIndex) => {
    const newRules = (question.qualification_rules || []).filter((_, i) => i !== ruleIndex);
    onChange({ ...question, qualification_rules: newRules });
  };

  const showOptions = hasOptions(question.type);
  const structured = isStructuredQuestion(question.type);
  const rules = question.qualification_rules || [];

  return (
    <div style={{
      border: '1px solid #E0E4EA', borderRadius: 12, padding: 20, marginBottom: 16,
      background: '#FAFBFC',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 26, height: 26, borderRadius: '50%', background: '#2E4E8D',
          color: '#fff', fontSize: 12, fontWeight: 700, flexShrink: 0,
        }}>
          {index + 1}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#0F1724', flex: 1 }}>
          {question.text || '(untitled question)'}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {!isFirst && (
            <button onClick={onMoveUp} style={iconBtnStyle} title="Move up">&uarr;</button>
          )}
          {!isLast && (
            <button onClick={onMoveDown} style={iconBtnStyle} title="Move down">&darr;</button>
          )}
          <button onClick={onRemove} style={{ ...iconBtnStyle, color: '#DC2626' }} title="Remove">
            &times;
          </button>
        </div>
      </div>

      {/* Question text */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Question Text</label>
        <input
          type="text"
          className={forms.fieldInput}
          placeholder="e.g., Are you legally authorized to work in the United States?"
          value={question.text}
          onChange={(e) => updateField('text', e.target.value)}
        />
      </div>

      {/* Type + Required row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelStyle}>Answer Type</label>
          <select
            className={forms.fieldInput}
            value={question.type}
            onChange={(e) => {
              const newType = e.target.value;
              const newOptions = hasOptions(newType) ? getDefaultOptions(newType) : [];
              // Update type and options together to avoid stale state overwrite
              onChange({ ...question, type: newType, options: newOptions });
            }}
          >
            {QUESTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Required?</label>
          <select
            className={forms.fieldInput}
            value={question.required ? 'yes' : 'no'}
            onChange={(e) => updateField('required', e.target.value === 'yes')}
          >
            <option value="yes">Yes — must answer</option>
            <option value="no">No — optional</option>
          </select>
        </div>
      </div>

      {/* Map to profile field — hidden for structured question types, which
          sync via dedicated action paths instead of scalar mapping. */}
      {!structured && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Map to Profile Field (optional)</label>
          <select
            className={forms.fieldInput}
            value={question.profile_field || ''}
            onChange={(e) => updateField('profile_field', e.target.value || '')}
          >
            {PROFILE_FIELD_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <div style={{ fontSize: 10, color: '#7A8BA0', marginTop: 4 }}>
            When set, the caregiver's answer will auto-populate this field on their profile.
          </div>
        </div>
      )}

      {/* Info callout for availability_schedule — explains auto-sync behavior */}
      {question.type === 'availability_schedule' && (
        <div style={{
          background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8,
          padding: '10px 14px', marginBottom: 12, fontSize: 12, color: '#1E40AF',
        }}>
          The applicant will pick weekdays and time ranges from a structured
          picker. On submit, their answer syncs directly to the caregiver's
          Availability tab (replacing any unpinned rows). Qualification rules
          and profile-field mapping don't apply to this type.
        </div>
      )}

      {/* Answer options (for yes/no, multiple choice, and multi-select) */}
      {showOptions && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Answer Options</label>
          {(question.options || []).map((opt, oi) => (
            <div key={oi} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
              <input
                type="text"
                className={forms.fieldInput}
                style={{ flex: 1 }}
                value={opt}
                onChange={(e) => updateOption(oi, e.target.value)}
                disabled={question.type === 'yes_no'}
              />
              {(question.type === 'multiple_choice' || question.type === 'multi_select') && (question.options || []).length > 2 && (
                <button onClick={() => removeOption(oi)} style={{ ...iconBtnStyle, color: '#DC2626', fontSize: 16 }}>
                  &times;
                </button>
              )}
            </div>
          ))}
          {(question.type === 'multiple_choice' || question.type === 'multi_select') && (
            <button
              onClick={addOption}
              style={{ background: 'none', border: 'none', color: '#2E4E8D', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '4px 0' }}
            >
              + Add option
            </button>
          )}
        </div>
      )}

      {/* Qualification rules — hidden for structured types which don't use them */}
      {!structured && (
      <div style={{
        borderTop: '1px solid #E8ECF1', paddingTop: 14, marginTop: 4,
      }}>
        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          Qualification Rules
          <span style={{ fontSize: 10, color: '#7A8BA0', fontWeight: 500, fontStyle: 'italic' }}>
            Define what happens based on each answer
          </span>
        </label>

        {rules.map((rule, ri) => (
          <div key={ri} style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8, marginBottom: 8,
            alignItems: 'start',
          }}>
            {/* Which answer triggers this rule */}
            <div>
              {showOptions ? (
                <select
                  className={forms.fieldInput}
                  value={rule.answer}
                  onChange={(e) => updateRule(ri, 'answer', e.target.value)}
                >
                  <option value="">Select answer...</option>
                  {(question.options || []).map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className={forms.fieldInput}
                  placeholder={question.type === 'number' ? 'e.g., < 1' : 'Answer value'}
                  value={rule.answer}
                  onChange={(e) => updateRule(ri, 'answer', e.target.value)}
                />
              )}
            </div>

            {/* Action */}
            <div>
              <select
                className={forms.fieldInput}
                value={rule.action}
                onChange={(e) => updateRule(ri, 'action', e.target.value)}
              >
                {QUALIFICATION_ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </div>

            {/* Reason */}
            <div>
              <input
                type="text"
                className={forms.fieldInput}
                placeholder="Reason (optional)"
                value={rule.reason || ''}
                onChange={(e) => updateRule(ri, 'reason', e.target.value)}
              />
            </div>

            {/* Remove */}
            <button onClick={() => removeRule(ri)} style={{ ...iconBtnStyle, color: '#DC2626', marginTop: 8 }}>
              &times;
            </button>
          </div>
        ))}

        <button
          onClick={addRule}
          style={{ background: 'none', border: 'none', color: '#2E4E8D', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '4px 0' }}
        >
          + Add qualification rule
        </button>
      </div>
      )}
    </div>
  );
}

// ─── Survey Template Form (create/edit) ───
function SurveyForm({ template, onSave, onCancel, saving }) {
  const [name, setName] = useState(template?.name || 'Pre-Screening Survey');
  const [description, setDescription] = useState(template?.description || 'Please answer the following questions to continue your application.');
  const [questions, setQuestions] = useState(template?.questions || []);
  const [enabled, setEnabled] = useState(template?.enabled ?? true);
  const [expiresHours, setExpiresHours] = useState(template?.expires_hours ?? 48);
  const [sendVia, setSendVia] = useState(template?.send_via || 'sms');
  const [smsTemplate, setSmsTemplate] = useState(template?.sms_template || 'Hi {{first_name}}, thank you for applying to Tremendous Care! Please complete this brief screening survey to continue: {{survey_link}}');
  const [emailSubject, setEmailSubject] = useState(template?.email_subject || 'Tremendous Care — Pre-Screening Survey');
  const [emailTemplate, setEmailTemplate] = useState(template?.email_template || 'Hi {{first_name}},\n\nThank you for your interest in joining Tremendous Care! Please complete this brief pre-screening survey to continue your application:\n\n{{survey_link}}\n\nThis survey takes about 2 minutes. Please complete it within {{expires_hours}} hours.\n\nBest regards,\nTremendous Care Recruiting Team');
  const [autoArchive, setAutoArchive] = useState(template?.auto_archive_disqualified ?? false);
  const [archiveReason, setArchiveReason] = useState(template?.archive_reason || 'Pre-screening: did not meet requirements');
  const [error, setError] = useState('');

  const updateQuestion = (index, updated) => {
    const next = [...questions];
    next[index] = updated;
    setQuestions(next);
  };

  const removeQuestion = (index) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  const moveQuestion = (from, to) => {
    const next = [...questions];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setQuestions(next);
  };

  const addQuestion = () => {
    setQuestions([...questions, createBlankQuestion()]);
  };

  const handleSave = () => {
    if (!name.trim()) { setError('Survey name is required.'); return; }
    if (questions.length === 0) { setError('Add at least one question.'); return; }
    const emptyQ = questions.find((q) => !q.text.trim());
    if (emptyQ) { setError('All questions must have text.'); return; }

    onSave({
      name: name.trim(),
      description: description.trim(),
      questions,
      enabled,
      expires_hours: parseInt(expiresHours, 10) || 48,
      send_via: sendVia,
      sms_template: smsTemplate,
      email_subject: emailSubject,
      email_template: emailTemplate,
      auto_archive_disqualified: autoArchive,
      archive_reason: archiveReason,
    });
  };

  return (
    <div>
      {/* Survey name & description */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Survey Name</label>
        <input
          type="text"
          className={forms.fieldInput}
          value={name}
          onChange={(e) => { setName(e.target.value); setError(''); }}
          placeholder="e.g., Pre-Screening Survey"
        />
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Description (shown to applicant)</label>
        <input
          type="text"
          className={forms.fieldInput}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Brief description..."
        />
      </div>

      {/* Settings row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
        <div>
          <label style={labelStyle}>Status</label>
          <select className={forms.fieldInput} value={enabled ? 'active' : 'inactive'} onChange={(e) => setEnabled(e.target.value === 'active')}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>Expires After</label>
          <select className={forms.fieldInput} value={expiresHours} onChange={(e) => setExpiresHours(e.target.value)}>
            <option value={24}>24 hours</option>
            <option value={48}>48 hours</option>
            <option value={72}>72 hours</option>
            <option value={168}>7 days</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>Send Via</label>
          <select className={forms.fieldInput} value={sendVia} onChange={(e) => setSendVia(e.target.value)}>
            <option value="sms">SMS only</option>
            <option value="email">Email only</option>
            <option value="both">SMS + Email</option>
          </select>
        </div>
      </div>

      {/* Message templates */}
      {(sendVia === 'sms' || sendVia === 'both') && (
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>SMS Template</label>
          <textarea
            className={forms.fieldInput}
            style={{ minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}
            value={smsTemplate}
            onChange={(e) => setSmsTemplate(e.target.value)}
          />
          <div style={{ fontSize: 10, color: '#7A8BA0', marginTop: 4 }}>
            Available: {'{{first_name}}'}, {'{{last_name}}'}, {'{{survey_link}}'}, {'{{expires_hours}}'}
          </div>
        </div>
      )}

      {(sendVia === 'email' || sendVia === 'both') && (
        <>
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>Email Subject</label>
            <input
              type="text"
              className={forms.fieldInput}
              value={emailSubject}
              onChange={(e) => setEmailSubject(e.target.value)}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Email Body</label>
            <textarea
              className={forms.fieldInput}
              style={{ minHeight: 100, resize: 'vertical', fontFamily: 'inherit' }}
              value={emailTemplate}
              onChange={(e) => setEmailTemplate(e.target.value)}
            />
            <div style={{ fontSize: 10, color: '#7A8BA0', marginTop: 4 }}>
              Available: {'{{first_name}}'}, {'{{last_name}}'}, {'{{survey_link}}'}, {'{{expires_hours}}'}
            </div>
          </div>
        </>
      )}

      {/* Disqualification settings */}
      <div style={{
        background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10,
        padding: 16, marginBottom: 20,
      }}>
        <label style={{ ...labelStyle, color: '#DC2626' }}>Disqualification Handling</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={autoArchive}
            onChange={(e) => setAutoArchive(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: '#DC2626' }}
          />
          <span style={{ fontSize: 13, color: '#0F1724', fontWeight: 500 }}>
            Automatically archive disqualified caregivers
          </span>
        </div>
        {autoArchive && (
          <div>
            <label style={{ ...labelStyle, marginTop: 8 }}>Archive Reason</label>
            <input
              type="text"
              className={forms.fieldInput}
              value={archiveReason}
              onChange={(e) => setArchiveReason(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* Questions section header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 16, borderBottom: '2px solid #EDF0F4', paddingBottom: 10,
      }}>
        <div>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#2E4E8D', textTransform: 'uppercase', letterSpacing: 1.1 }}>
            Questions
          </span>
          <span style={{ fontSize: 11, color: '#7A8BA0', marginLeft: 8 }}>
            {questions.length} question{questions.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          className={btn.primaryBtn}
          style={{ padding: '7px 14px', fontSize: 12 }}
          onClick={addQuestion}
        >
          + Add Question
        </button>
      </div>

      {/* Question editors */}
      {questions.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '32px 20px', color: '#7A8BA0',
          border: '2px dashed #E0E4EA', borderRadius: 12, marginBottom: 16,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No questions yet</div>
          <div style={{ fontSize: 12 }}>Click "Add Question" to get started</div>
        </div>
      )}

      {questions.map((q, i) => (
        <QuestionEditor
          key={q.id}
          question={q}
          index={i}
          onChange={(updated) => updateQuestion(i, updated)}
          onRemove={() => removeQuestion(i)}
          onMoveUp={() => moveQuestion(i, i - 1)}
          onMoveDown={() => moveQuestion(i, i + 1)}
          isFirst={i === 0}
          isLast={i === questions.length - 1}
        />
      ))}

      {/* Error */}
      {error && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8,
          padding: '10px 14px', fontSize: 13, color: '#DC2626', fontWeight: 600, marginBottom: 12,
        }}>
          {error}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button
          className={btn.primaryBtn}
          style={{ padding: '10px 24px', fontSize: 13, opacity: saving ? 0.6 : 1 }}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving...' : template?.id ? 'Save Changes' : 'Create Survey'}
        </button>
        <button
          className={btn.secondaryBtn}
          style={{ padding: '10px 20px', fontSize: 13 }}
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Response Summary Row ───
function ResponseRow({ resp }) {
  const statusConfig = {
    pending: { bg: '#FFFBEB', color: '#A16207', border: '#FDE68A', label: 'Pending' },
    qualified: { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0', label: 'Qualified' },
    flagged: { bg: '#FFFBEB', color: '#A16207', border: '#FDE68A', label: 'Flagged' },
    disqualified: { bg: '#FEF2F2', color: '#DC2626', border: '#FECACA', label: 'Disqualified' },
  };
  const sc = statusConfig[resp.status] || statusConfig.pending;
  const sentDate = resp.sent_at ? new Date(resp.sent_at).toLocaleDateString() : '—';
  const submittedDate = resp.submitted_at ? new Date(resp.submitted_at).toLocaleDateString() : '—';

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 90px 90px 100px',
      padding: '10px 16px', alignItems: 'center', fontSize: 13,
      borderBottom: '1px solid #F0F3F7',
    }}>
      <span style={{ fontWeight: 500, color: '#0F1724', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {resp.caregiver_id}
      </span>
      <span style={{ color: '#7A8BA0', fontSize: 12 }}>{sentDate}</span>
      <span style={{ color: '#7A8BA0', fontSize: 12 }}>{submittedDate}</span>
      <span style={{
        display: 'inline-block', padding: '3px 10px', borderRadius: 6,
        fontSize: 11, fontWeight: 700, background: sc.bg, color: sc.color, border: `1px solid ${sc.border}`,
      }}>
        {sc.label}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Main Export: SurveySettings
// ═══════════════════════════════════════════════════════════════

export function SurveySettings({ showToast }) {
  const [templates, setTemplates] = useState([]);
  const [responses, setResponses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null = list view, 'new' = create, template obj = edit
  const [saving, setSaving] = useState(false);
  const [showResponses, setShowResponses] = useState(false);

  // Load templates
  const loadTemplates = useCallback(async () => {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from('survey_templates')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setTemplates(data || []);
    } catch (err) {
      console.error('Failed to load survey templates:', err);
    }
  }, []);

  // Load recent responses
  const loadResponses = useCallback(async () => {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from('survey_responses')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      setResponses(data || []);
    } catch (err) {
      console.error('Failed to load survey responses:', err);
    }
  }, []);

  useEffect(() => {
    Promise.all([loadTemplates(), loadResponses()]).finally(() => setLoading(false));
  }, [loadTemplates, loadResponses]);

  const handleSave = async (data) => {
    setSaving(true);
    try {
      if (editing && editing !== 'new' && editing.id) {
        // Update existing
        const { error } = await supabase
          .from('survey_templates')
          .update({ ...data, updated_at: new Date().toISOString() })
          .eq('id', editing.id);
        if (error) throw error;
        showToast?.('Survey updated successfully!');
      } else {
        // Create new
        const { error } = await supabase
          .from('survey_templates')
          .insert(data);
        if (error) throw error;
        showToast?.('Survey created successfully!');
      }
      await loadTemplates();
      setEditing(null);
    } catch (err) {
      console.error('Failed to save survey:', err);
      showToast?.('Failed to save survey. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (templateId, currentEnabled) => {
    try {
      const { error } = await supabase
        .from('survey_templates')
        .update({ enabled: !currentEnabled, updated_at: new Date().toISOString() })
        .eq('id', templateId);
      if (error) throw error;
      setTemplates((prev) => prev.map((t) => t.id === templateId ? { ...t, enabled: !currentEnabled } : t));
      showToast?.(`Survey ${!currentEnabled ? 'activated' : 'deactivated'}.`);
    } catch (err) {
      console.error('Failed to toggle survey:', err);
    }
  };

  const deleteTemplate = async (templateId) => {
    if (!window.confirm('Delete this survey template? Existing responses will be kept.')) return;
    try {
      const { error } = await supabase
        .from('survey_templates')
        .delete()
        .eq('id', templateId);
      if (error) throw error;
      setTemplates((prev) => prev.filter((t) => t.id !== templateId));
      showToast?.('Survey deleted.');
    } catch (err) {
      console.error('Failed to delete survey:', err);
    }
  };

  if (loading) {
    return (
      <CollapsibleCard title="Pre-Screening Surveys">
        <div style={{ padding: '20px 24px', color: '#7A8BA0', fontSize: 13 }}>Loading...</div>
      </CollapsibleCard>
    );
  }

  // ── Edit / Create View ──
  if (editing) {
    return (
      <CollapsibleCard
        title={editing === 'new' ? 'Create Survey' : 'Edit Survey'}
        storageKey="tc_collapsible_card:Pre-Screening Surveys"
        defaultOpen
      >
        <div style={{ padding: '20px 24px' }}>
          <SurveyForm
            template={editing === 'new' ? null : editing}
            onSave={handleSave}
            onCancel={() => setEditing(null)}
            saving={saving}
          />
        </div>
      </CollapsibleCard>
    );
  }

  // ── List View ──
  const responseCounts = {};
  for (const r of responses) {
    responseCounts[r.survey_template_id] = (responseCounts[r.survey_template_id] || 0) + 1;
  }

  return (
    <CollapsibleCard
      title="Pre-Screening Surveys"
      description="Automatically sent to new applicants"
      headerRight={
        <button
          className={btn.primaryBtn}
          style={{ padding: '8px 16px', fontSize: 12 }}
          onClick={(e) => { e.stopPropagation(); setEditing('new'); }}
        >
          + Create Survey
        </button>
      }
    >
      <div style={{ padding: '20px 24px' }}>
        {templates.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '32px 20px', color: '#7A8BA0',
            border: '2px dashed #E0E4EA', borderRadius: 12,
          }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>&#128203;</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No surveys yet</div>
            <div style={{ fontSize: 12, marginBottom: 16 }}>
              Create a pre-screening survey to automatically qualify new applicants
            </div>
            <button
              className={btn.primaryBtn}
              style={{ padding: '8px 16px', fontSize: 12 }}
              onClick={() => setEditing('new')}
            >
              Create Your First Survey
            </button>
          </div>
        ) : (
          <>
            {/* Templates list */}
            <div style={{ border: '1px solid #E0E4EA', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
              {/* Header */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 80px 90px 120px',
                padding: '10px 16px', background: '#F8F9FB',
                fontSize: 10, fontWeight: 700, color: '#7A8BA0',
                textTransform: 'uppercase', letterSpacing: 1,
                borderBottom: '1px solid #E0E4EA',
              }}>
                <span>Survey</span>
                <span>Status</span>
                <span>Responses</span>
                <span style={{ textAlign: 'right' }}>Actions</span>
              </div>

              {templates.map((t) => (
                <div key={t.id} style={{
                  display: 'grid', gridTemplateColumns: '1fr 80px 90px 120px',
                  padding: '12px 16px', alignItems: 'center',
                  borderBottom: '1px solid #F0F3F7',
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0F1724' }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: '#7A8BA0' }}>
                      {(t.questions || []).length} question{(t.questions || []).length !== 1 ? 's' : ''} &middot; {t.send_via}
                    </div>
                  </div>
                  <SurveyStatusBadge enabled={t.enabled} />
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#4B5563' }}>
                    {responseCounts[t.id] || 0}
                  </span>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button
                      className={btn.editBtn}
                      style={{ padding: '5px 10px', fontSize: 11 }}
                      onClick={() => setEditing(t)}
                    >
                      Edit
                    </button>
                    <button
                      className={btn.editBtn}
                      style={{
                        padding: '5px 10px', fontSize: 11,
                        color: t.enabled ? '#A16207' : '#15803D',
                        borderColor: t.enabled ? '#FDE68A' : '#BBF7D0',
                      }}
                      onClick={() => toggleEnabled(t.id, t.enabled)}
                    >
                      {t.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      className={btn.editBtn}
                      style={{ padding: '5px 10px', fontSize: 11, color: '#DC2626', borderColor: '#FECACA' }}
                      onClick={() => deleteTemplate(t.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Recent responses */}
            <div>
              <button
                onClick={() => { setShowResponses(!showResponses); if (!showResponses) loadResponses(); }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: 'none', border: '1px solid #E0E4EA', borderRadius: 8,
                  padding: '6px 12px', fontSize: 12, fontWeight: 600, color: '#4B5563',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {showResponses ? 'Hide' : 'Show'} Recent Responses
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 20, height: 18, padding: '0 6px', borderRadius: 9,
                  background: '#E0E4EA', fontSize: 10, fontWeight: 700, color: '#4B5563',
                }}>
                  {responses.length}
                </span>
              </button>

              {showResponses && responses.length > 0 && (
                <div style={{ border: '1px solid #E0E4EA', borderRadius: 12, overflow: 'hidden', marginTop: 12 }}>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 90px 90px 100px',
                    padding: '10px 16px', background: '#F8F9FB',
                    fontSize: 10, fontWeight: 700, color: '#7A8BA0',
                    textTransform: 'uppercase', letterSpacing: 1,
                    borderBottom: '1px solid #E0E4EA',
                  }}>
                    <span>Caregiver</span>
                    <span>Sent</span>
                    <span>Submitted</span>
                    <span>Status</span>
                  </div>
                  {responses.map((r) => <ResponseRow key={r.id} resp={r} />)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </CollapsibleCard>
  );
}

// ─── Shared Styles ───
const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 700, color: '#7A8BA0',
  textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6,
};

const iconBtnStyle = {
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: 14, color: '#7A8BA0', padding: '2px 6px', borderRadius: 4,
  lineHeight: 1,
};
