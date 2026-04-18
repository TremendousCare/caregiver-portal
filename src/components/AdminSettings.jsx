import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { PHASES } from '../lib/constants';
import { getPhaseTasks } from '../lib/storage';
import btn from '../styles/buttons.module.css';
import forms from '../styles/forms.module.css';
import cards from '../styles/cards.module.css';
import layout from '../styles/layout.module.css';
import { AutomationSettings } from './AutomationSettings';
import ActionItemRuleSettings from './ActionItemRuleSettings';
import { AutonomySettings } from './AutonomySettings';
import { ESignFieldEditor } from './ESignFieldEditor';
import { AgentPerformance } from './AgentPerformance';
import { SurveySettings } from './SurveySettings';
import { CollapsibleCard } from '../shared/components/CollapsibleCard';

// ─── Settings Section Card ───
function SettingsCard({ title, description, children }) {
  return (
    <CollapsibleCard title={title} description={description}>
      <div style={{ padding: '20px 24px' }}>
        {children}
      </div>
    </CollapsibleCard>
  );
}

// ─── Reusable Editable Setting ───
// Loads a single key from app_settings, displays it, and allows inline editing.
function EditableSetting({ settingKey, label, helpText, editHelpText, placeholder, validate, formatDisplay, showToast }) {
  const [value, setValue] = useState('');
  const [editValue, setEditValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const { data, error: fetchErr } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', settingKey)
          .single();

        if (fetchErr) throw fetchErr;
        const val = data?.value || '';
        setValue(typeof val === 'string' ? val : String(val));
      } catch (err) {
        console.error(`Failed to load ${settingKey}:`, err);
        setValue('(not configured)');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [settingKey]);

  const startEdit = useCallback(() => {
    setEditValue(value === '(not configured)' ? '' : value);
    setEditing(true);
    setError('');
  }, [value]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setError('');
  }, []);

  const save = useCallback(async () => {
    const trimmed = editValue.trim();
    if (!trimmed) {
      setError(`${label} is required.`);
      return;
    }
    if (validate) {
      const validationError = validate(trimmed);
      if (validationError) {
        setError(validationError);
        return;
      }
    }

    setSaving(true);
    setError('');
    try {
      const { error: upsertErr } = await supabase
        .from('app_settings')
        .upsert(
          { key: settingKey, value: trimmed, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );

      if (upsertErr) throw upsertErr;

      setValue(trimmed);
      setEditing(false);
      showToast?.(`${label} updated successfully!`);
    } catch (err) {
      console.error(`Failed to save ${settingKey}:`, err);
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [editValue, settingKey, label, validate, showToast]);

  if (loading) {
    return <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>;
  }

  const isConfigured = value && value !== '(not configured)';
  const displayValue = formatDisplay ? formatDisplay(value) : value;

  return (
    <div>
      {/* Status indicator */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
        padding: '10px 14px',
        background: isConfigured ? '#F0FDF4' : '#FFFBEB',
        borderRadius: 10,
        border: `1px solid ${isConfigured ? '#BBF7D0' : '#FDE68A'}`,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: isConfigured ? '#22C55E' : '#EAB308',
        }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: isConfigured ? '#15803D' : '#A16207' }}>
          {isConfigured ? 'Connected' : 'Not configured'}
        </span>
      </div>

      {/* Display mode */}
      {!editing ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#7A8BA0', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>
              {label}
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#0F1724' }}>
              {displayValue}
            </div>
            {helpText && (
              <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 4 }}>
                {helpText}
              </div>
            )}
          </div>
          <button
            className={btn.editBtn}
            onClick={startEdit}
            onMouseEnter={(e) => { e.target.style.background = '#F0F4FA'; }}
            onMouseLeave={(e) => { e.target.style.background = '#fff'; }}
          >
            Change
          </button>
        </div>
      ) : (
        /* Edit mode */
        <div>
          <label className={forms.fieldLabel}>{label}</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <input
                type="text"
                className={forms.fieldInput}
                style={{ borderColor: error ? '#DC4A3A' : '#E0E4EA' }}
                value={editValue}
                onChange={(e) => { setEditValue(e.target.value); setError(''); }}
                placeholder={placeholder}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancelEdit(); }}
              />
              {error && (
                <div style={{ fontSize: 12, color: '#DC4A3A', fontWeight: 600, marginTop: 6 }}>{error}</div>
              )}
              {editHelpText && (
                <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 6 }}>
                  {editHelpText}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              className={btn.primaryBtn}
              style={{ padding: '9px 20px', fontSize: 13, opacity: saving ? 0.6 : 1 }}
              onClick={save}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              className={btn.secondaryBtn}
              style={{ padding: '9px 20px', fontSize: 13 }}
              onClick={cancelEdit}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Validators ───
function validateEmail(value) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Please enter a valid email address.';
  return null;
}

function validatePhoneNumber(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10) return 'Please enter a valid phone number (at least 10 digits).';
  if (digits.length > 11) return 'Phone number is too long.';
  return null;
}

function formatPhoneDisplay(value) {
  if (!value || value === '(not configured)') return value;
  // Format +19498732367 as +1 (949) 873-2367
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return value;
}

// ─── Integration Info Card (read-only) ───
function IntegrationInfoCard({ title, status, details }) {
  const isConnected = status === 'connected';
  return (
    <div className={cards.profileCard}>
      <div className={cards.profileCardHeader} style={{ borderBottom: 'none', paddingBottom: 20 }}>
        <div>
          <h3 className={cards.profileCardTitle} style={{ marginBottom: 4 }}>{title}</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 7, height: 7, borderRadius: '50%',
              background: isConnected ? '#22C55E' : '#94A3B8',
            }} />
            <span style={{
              fontSize: 11, fontWeight: 600,
              color: isConnected ? '#15803D' : '#94A3B8',
            }}>
              {isConnected ? 'Connected' : 'Not configured'}
            </span>
          </div>
        </div>
        <span style={{
          fontSize: 11, fontWeight: 600, color: '#7A8BA0',
          background: '#F0F2F5', padding: '4px 10px', borderRadius: 6,
        }}>
          Environment Config
        </span>
      </div>
      {details && (
        <div style={{ padding: '0 24px 20px', fontSize: 12, color: '#7A8BA0', lineHeight: 1.5 }}>
          {details}
        </div>
      )}
    </div>
  );
}

// ─── User Management ───
function UserManagement({ showToast, currentUserEmail }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('user_roles')
          .select('*')
          .order('role', { ascending: true });
        if (error) throw error;
        setUsers(data || []);
      } catch (err) {
        console.error('Failed to load user roles:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const changeRole = useCallback(async (email, newRole) => {
    const action = newRole === 'admin' ? 'grant admin access to' : 'remove admin access from';
    if (!window.confirm(`Are you sure you want to ${action} ${email}?`)) return;

    setChanging(email);
    try {
      const { error } = await supabase
        .from('user_roles')
        .update({
          role: newRole,
          updated_at: new Date().toISOString(),
          updated_by: currentUserEmail,
        })
        .eq('email', email);

      if (error) throw error;
      setUsers((prev) => prev.map((u) => u.email === email ? { ...u, role: newRole } : u));
      showToast?.(`${email} is now ${newRole === 'admin' ? 'an admin' : 'a member'}`);
    } catch (err) {
      console.error('Failed to update role:', err);
      showToast?.('Failed to update role. Please try again.');
    } finally {
      setChanging(null);
    }
  }, [currentUserEmail, showToast]);

  if (loading) {
    return (
      <SettingsCard title="User Access & Roles" description="Login Permissions">
        <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>
      </SettingsCard>
    );
  }

  const admins = users.filter((u) => u.role === 'admin');
  const members = users.filter((u) => u.role === 'member');

  return (
    <SettingsCard title="User Access & Roles" description={`${users.length} user${users.length !== 1 ? 's' : ''}`}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: '#7A8BA0', lineHeight: 1.5 }}>
          Admins can access Settings, change integration configurations, and manage team roles.
          Members can view and manage caregivers but cannot access this page.
        </div>
      </div>

      {/* User list */}
      <div style={{ border: '1px solid #E0E4EA', borderRadius: 12, overflow: 'hidden' }}>
        {/* Header row */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 100px 120px',
          padding: '10px 16px', background: '#F8F9FB',
          fontSize: 10, fontWeight: 700, color: '#7A8BA0',
          textTransform: 'uppercase', letterSpacing: 1,
          borderBottom: '1px solid #E0E4EA',
        }}>
          <span>Email</span>
          <span>Role</span>
          <span style={{ textAlign: 'right' }}>Action</span>
        </div>

        {/* Admins first, then members */}
        {[...admins, ...members].map((user, i) => {
          const isCurrentUser = user.email === currentUserEmail?.toLowerCase();
          const isAdminRole = user.role === 'admin';
          return (
            <div key={user.email} style={{
              display: 'grid', gridTemplateColumns: '1fr 100px 120px',
              alignItems: 'center',
              padding: '12px 16px',
              borderBottom: i < users.length - 1 ? '1px solid #F0F3F7' : 'none',
              background: isCurrentUser ? '#F8FAFF' : '#fff',
            }}>
              {/* Email */}
              <div style={{ fontSize: 13, fontWeight: 500, color: '#0F1724', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user.email}
                {isCurrentUser && (
                  <span style={{ fontSize: 10, color: '#7A8BA0', marginLeft: 6, fontWeight: 600 }}>(you)</span>
                )}
              </div>

              {/* Role badge */}
              <div>
                <span style={{
                  display: 'inline-block',
                  padding: '3px 10px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  background: isAdminRole ? '#F0FDF4' : '#F0F4FA',
                  color: isAdminRole ? '#15803D' : '#2E4E8D',
                  border: `1px solid ${isAdminRole ? '#BBF7D0' : '#D5DCE6'}`,
                }}>
                  {isAdminRole ? 'Admin' : 'Member'}
                </span>
              </div>

              {/* Action button */}
              <div style={{ textAlign: 'right' }}>
                {isCurrentUser ? (
                  <span style={{ fontSize: 11, color: '#94A3B8' }}>—</span>
                ) : (
                  <button
                    className={btn.editBtn}
                    style={{
                      padding: '5px 12px',
                      fontSize: 11,
                      opacity: changing === user.email ? 0.5 : 1,
                      color: isAdminRole ? '#DC4A3A' : '#15803D',
                      borderColor: isAdminRole ? '#FECACA' : '#BBF7D0',
                    }}
                    onClick={() => changeRole(user.email, isAdminRole ? 'member' : 'admin')}
                    disabled={!!changing}
                    onMouseEnter={(e) => { e.target.style.background = isAdminRole ? '#FEF2F2' : '#F0FDF4'; }}
                    onMouseLeave={(e) => { e.target.style.background = '#fff'; }}
                  >
                    {changing === user.email ? '...' : isAdminRole ? 'Make Member' : 'Make Admin'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </SettingsCard>
  );
}

// ─── Team Members Directory ───
// CRUD for the `team_members` table: the employee directory.
// This is separate from UserManagement (which controls login access via
// `user_roles`). A team member is any employee we want on record —
// regardless of whether they log into the app.
function TeamMembersManagement({ showToast, currentUserEmail }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  // editingKey: null | '__new__' | existing email of row being edited
  const [editingKey, setEditingKey] = useState(null);
  const [formData, setFormData] = useState({
    email: '',
    display_name: '',
    job_title: '',
    personal_phone: '',
    notes: '',
    is_active: true,
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('team_members')
          .select('*')
          .order('display_name', { ascending: true });
        if (error) throw error;
        setMembers(data || []);
      } catch (err) {
        console.error('Failed to load team members:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const resetForm = useCallback(() => {
    setFormData({
      email: '',
      display_name: '',
      job_title: '',
      personal_phone: '',
      notes: '',
      is_active: true,
    });
    setFormError('');
  }, []);

  const startAdd = useCallback(() => {
    resetForm();
    setEditingKey('__new__');
  }, [resetForm]);

  const startEdit = useCallback((member) => {
    setFormData({
      email: member.email || '',
      display_name: member.display_name || '',
      job_title: member.job_title || '',
      personal_phone: member.personal_phone || '',
      notes: member.notes || '',
      is_active: member.is_active !== false,
    });
    setFormError('');
    setEditingKey(member.email);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingKey(null);
    resetForm();
  }, [resetForm]);

  const save = useCallback(async () => {
    const name = formData.display_name.trim();
    const email = formData.email.trim().toLowerCase();
    const title = formData.job_title.trim();
    const phone = formData.personal_phone.trim();
    const notes = formData.notes.trim();

    if (!name) { setFormError('Display name is required.'); return; }
    if (!email) { setFormError('Email is required.'); return; }
    const emailErr = validateEmail(email);
    if (emailErr) { setFormError(emailErr); return; }
    if (phone) {
      const phoneErr = validatePhoneNumber(phone);
      if (phoneErr) { setFormError(phoneErr); return; }
    }

    setSaving(true);
    setFormError('');
    try {
      const isNew = editingKey === '__new__';
      const payload = {
        email,
        display_name: name,
        job_title: title || null,
        personal_phone: phone || null,
        notes: notes || null,
        is_active: formData.is_active,
        updated_at: new Date().toISOString(),
        updated_by: currentUserEmail || null,
      };

      if (isNew) {
        const { error } = await supabase
          .from('team_members')
          .insert(payload);
        if (error) throw error;
        setMembers((prev) => [...prev, payload].sort((a, b) =>
          (a.display_name || '').localeCompare(b.display_name || '')
        ));
        showToast?.(`${name} added to team members.`);
      } else {
        // Editing existing: email is the PK, disallow changing it here
        const { error } = await supabase
          .from('team_members')
          .update(payload)
          .eq('email', editingKey);
        if (error) throw error;
        setMembers((prev) => prev.map((m) =>
          m.email === editingKey ? { ...m, ...payload } : m
        ).sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')));
        showToast?.(`${name} updated.`);
      }

      setEditingKey(null);
      resetForm();
    } catch (err) {
      console.error('Failed to save team member:', err);
      if (err?.code === '23505') {
        setFormError('A team member with that email already exists.');
      } else {
        setFormError('Failed to save. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }, [formData, editingKey, currentUserEmail, showToast, resetForm]);

  const toggleActive = useCallback(async (member) => {
    const newActive = !member.is_active;
    const verb = newActive ? 'reactivate' : 'deactivate';
    if (!window.confirm(`Are you sure you want to ${verb} ${member.display_name}?`)) return;

    try {
      const { error } = await supabase
        .from('team_members')
        .update({
          is_active: newActive,
          updated_at: new Date().toISOString(),
          updated_by: currentUserEmail || null,
        })
        .eq('email', member.email);
      if (error) throw error;
      setMembers((prev) => prev.map((m) =>
        m.email === member.email ? { ...m, is_active: newActive } : m
      ));
      showToast?.(`${member.display_name} ${newActive ? 'reactivated' : 'deactivated'}.`);
    } catch (err) {
      console.error('Failed to toggle active:', err);
      showToast?.('Failed to update. Please try again.');
    }
  }, [currentUserEmail, showToast]);

  const activeMembers = members.filter((m) => m.is_active !== false);
  const archivedMembers = members.filter((m) => m.is_active === false);
  const visibleMembers = showArchived ? archivedMembers : activeMembers;

  if (loading) {
    return (
      <SettingsCard title="Team Members" description="Employee Directory">
        <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>
      </SettingsCard>
    );
  }

  const renderForm = () => (
    <div style={{
      padding: 16,
      background: '#F8FAFF',
      border: '1px solid #D5DCE6',
      borderRadius: 10,
      marginBottom: 14,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#0F1724', marginBottom: 12 }}>
        {editingKey === '__new__' ? 'Add Team Member' : `Edit ${formData.display_name || formData.email}`}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
        <div>
          <label className={forms.fieldLabel}>Display Name *</label>
          <input
            type="text"
            className={forms.fieldInput}
            value={formData.display_name}
            onChange={(e) => setFormData({ ...formData, display_name: e.target.value })}
            placeholder="e.g. Daniela Hernandez"
            autoFocus
          />
        </div>
        <div>
          <label className={forms.fieldLabel}>Email *</label>
          <input
            type="email"
            className={forms.fieldInput}
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            placeholder="e.g. daniela@tremendouscareca.com"
            disabled={editingKey !== '__new__'}
            style={{ opacity: editingKey !== '__new__' ? 0.6 : 1 }}
          />
          {editingKey !== '__new__' && (
            <div style={{ fontSize: 10, color: '#7A8BA0', marginTop: 4 }}>
              Email cannot be changed. Deactivate and re-add if needed.
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
        <div>
          <label className={forms.fieldLabel}>Job Title</label>
          <input
            type="text"
            className={forms.fieldInput}
            value={formData.job_title}
            onChange={(e) => setFormData({ ...formData, job_title: e.target.value })}
            placeholder="e.g. Talent Acquisition Specialist"
          />
        </div>
        <div>
          <label className={forms.fieldLabel}>Personal Phone</label>
          <input
            type="tel"
            className={forms.fieldInput}
            value={formData.personal_phone}
            onChange={(e) => setFormData({ ...formData, personal_phone: e.target.value })}
            placeholder="e.g. (949) 555-0100"
          />
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label className={forms.fieldLabel}>Notes</label>
        <textarea
          className={forms.fieldInput}
          value={formData.notes}
          onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
          placeholder="Optional — anything else you want to remember about this team member"
          rows={2}
          style={{ resize: 'vertical', fontFamily: 'inherit' }}
        />
      </div>

      {formError && (
        <div style={{
          fontSize: 12, color: '#DC4A3A', fontWeight: 600,
          marginBottom: 10, padding: '6px 10px',
          background: '#FEF2F2', borderRadius: 6,
          border: '1px solid #FECACA',
        }}>
          {formError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className={btn.primaryBtn}
          style={{ padding: '8px 18px', fontSize: 13, opacity: saving ? 0.6 : 1 }}
          onClick={save}
          disabled={saving}
        >
          {saving ? 'Saving...' : (editingKey === '__new__' ? 'Add Member' : 'Save Changes')}
        </button>
        <button
          className={btn.secondaryBtn}
          style={{ padding: '8px 18px', fontSize: 13 }}
          onClick={cancelEdit}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <SettingsCard
      title="Team Members"
      description={`${activeMembers.length} active${archivedMembers.length > 0 ? ` · ${archivedMembers.length} archived` : ''}`}
    >
      <div style={{ marginBottom: 12, fontSize: 11, color: '#7A8BA0', lineHeight: 1.5 }}>
        The employee directory — name, job title, email, and personal phone for each team member.
        This is used for audit trails and (later) to route SMS/email outreach to the right person.
        Adding someone here does NOT give them app access; login permissions are managed under User Access &amp; Roles above.
      </div>

      {/* Form (shown when adding or editing) */}
      {editingKey !== null && renderForm()}

      {/* Header row with Add button + archived toggle */}
      {editingKey === null && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <button
            className={btn.primaryBtn}
            style={{ padding: '8px 16px', fontSize: 13 }}
            onClick={startAdd}
          >
            + Add Team Member
          </button>
          {archivedMembers.length > 0 && (
            <button
              className={btn.secondaryBtn}
              style={{ padding: '6px 12px', fontSize: 11 }}
              onClick={() => setShowArchived((s) => !s)}
            >
              {showArchived ? `Show active (${activeMembers.length})` : `Show archived (${archivedMembers.length})`}
            </button>
          )}
        </div>
      )}

      {/* Team member list */}
      {visibleMembers.length === 0 ? (
        <div style={{
          padding: 28,
          textAlign: 'center',
          color: '#7A8BA0',
          fontSize: 13,
          background: '#F8F9FB',
          borderRadius: 10,
          border: '1px dashed #E0E4EA',
        }}>
          {showArchived
            ? 'No archived team members.'
            : 'No team members yet. Click "Add Team Member" to add your first employee.'}
        </div>
      ) : (
        <div style={{ border: '1px solid #E0E4EA', borderRadius: 12, overflow: 'hidden' }}>
          {/* Header row */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 1.4fr 1.6fr 1.2fr 140px',
            padding: '10px 16px', background: '#F8F9FB',
            fontSize: 10, fontWeight: 700, color: '#7A8BA0',
            textTransform: 'uppercase', letterSpacing: 1,
            borderBottom: '1px solid #E0E4EA',
          }}>
            <span>Name</span>
            <span>Job Title</span>
            <span>Email</span>
            <span>Personal Phone</span>
            <span style={{ textAlign: 'right' }}>Actions</span>
          </div>

          {visibleMembers.map((member, i) => (
            <div
              key={member.email}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.4fr 1.4fr 1.6fr 1.2fr 140px',
                alignItems: 'center',
                padding: '12px 16px',
                borderBottom: i < visibleMembers.length - 1 ? '1px solid #F0F3F7' : 'none',
                background: '#fff',
                opacity: member.is_active === false ? 0.6 : 1,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: '#0F1724', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {member.display_name || '—'}
              </div>
              <div style={{ fontSize: 12, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {member.job_title || <span style={{ color: '#94A3B8' }}>—</span>}
              </div>
              <div style={{ fontSize: 12, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {member.email}
              </div>
              <div style={{ fontSize: 12, color: '#475569' }}>
                {member.personal_phone ? formatPhoneDisplay(member.personal_phone) : <span style={{ color: '#94A3B8' }}>—</span>}
              </div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  className={btn.editBtn}
                  style={{ padding: '5px 10px', fontSize: 11 }}
                  onClick={() => startEdit(member)}
                >
                  Edit
                </button>
                <button
                  className={btn.editBtn}
                  style={{
                    padding: '5px 10px',
                    fontSize: 11,
                    color: member.is_active === false ? '#15803D' : '#DC4A3A',
                    borderColor: member.is_active === false ? '#BBF7D0' : '#FECACA',
                  }}
                  onClick={() => toggleActive(member)}
                >
                  {member.is_active === false ? 'Reactivate' : 'Archive'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </SettingsCard>
  );
}

// ─── Communication Routes ───
// CRUD for the `communication_routes` table — maps outreach categories
// (general, onboarding, scheduling, ...) to a sending identity (phone
// number + RingCentral JWT stored in Supabase Vault).
//
// JWT handling: JWTs are write-only. The UI never reads a JWT value;
// it can only show "Configured" or "Not set" status. Writes go through
// two SECURITY DEFINER RPCs:
//   - set_route_ringcentral_jwt(p_category, p_jwt)
//   - clear_route_ringcentral_jwt(p_category)
//
// This UI is data-entry only. The bulk-sms edge function does NOT
// read from this table yet — that wiring is Step 5 (separate PR).
function CommunicationRoutesManagement({ showToast, currentUserEmail }) {
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);

  // Route add/edit form state
  const [editingKey, setEditingKey] = useState(null); // null | '__new__' | category
  const [formData, setFormData] = useState({
    category: '',
    label: '',
    description: '',
    sms_from_number: '',
    is_default: false,
    is_active: true,
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // JWT set/clear state (separate from the route edit form)
  const [jwtEditingKey, setJwtEditingKey] = useState(null); // category or null
  const [jwtValue, setJwtValue] = useState('');
  const [jwtSaving, setJwtSaving] = useState(false);
  const [jwtError, setJwtError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('communication_routes')
          .select('*')
          .order('sort_order', { ascending: true });
        if (error) throw error;
        setRoutes(data || []);
      } catch (err) {
        console.error('Failed to load communication routes:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const resetForm = useCallback(() => {
    setFormData({
      category: '',
      label: '',
      description: '',
      sms_from_number: '',
      is_default: false,
      is_active: true,
    });
    setFormError('');
  }, []);

  const startAdd = useCallback(() => {
    resetForm();
    setJwtEditingKey(null);
    setEditingKey('__new__');
  }, [resetForm]);

  const startEdit = useCallback((route) => {
    setFormData({
      category: route.category || '',
      label: route.label || '',
      description: route.description || '',
      sms_from_number: route.sms_from_number || '',
      is_default: route.is_default === true,
      is_active: route.is_active !== false,
    });
    setFormError('');
    setJwtEditingKey(null);
    setEditingKey(route.category);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingKey(null);
    resetForm();
  }, [resetForm]);

  const saveRoute = useCallback(async () => {
    const category = formData.category.trim().toLowerCase();
    const label = formData.label.trim();
    const description = formData.description.trim();
    const phone = formData.sms_from_number.trim();

    if (!label) { setFormError('Label is required.'); return; }
    if (editingKey === '__new__') {
      if (!category) { setFormError('Category is required.'); return; }
      if (!/^[a-z0-9_]+$/.test(category)) {
        setFormError('Category must be lowercase letters, numbers, and underscores only (e.g. "onboarding", "new_hire_followup").');
        return;
      }
    }
    if (phone) {
      const phoneErr = validatePhoneNumber(phone);
      if (phoneErr) { setFormError(phoneErr); return; }
    }

    setSaving(true);
    setFormError('');
    try {
      const isNew = editingKey === '__new__';
      const payload = {
        category: isNew ? category : editingKey,
        label,
        description: description || null,
        sms_from_number: phone || null,
        is_default: formData.is_default,
        is_active: formData.is_active,
        updated_at: new Date().toISOString(),
        updated_by: currentUserEmail || null,
      };

      // If this route is being set as default, unset the existing default first.
      // The unique partial index enforces only one default at a time, so we
      // need to clear the old one in the same logical operation.
      if (formData.is_default) {
        const currentDefault = routes.find((r) => r.is_default && r.category !== payload.category);
        if (currentDefault) {
          const { error: clearErr } = await supabase
            .from('communication_routes')
            .update({ is_default: false, updated_at: new Date().toISOString(), updated_by: currentUserEmail || null })
            .eq('category', currentDefault.category);
          if (clearErr) throw clearErr;
        }
      }

      if (isNew) {
        const { error } = await supabase
          .from('communication_routes')
          .insert(payload);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('communication_routes')
          .update(payload)
          .eq('category', editingKey);
        if (error) throw error;
      }

      // Refresh routes to reflect any default-flag swap
      const { data: refreshed } = await supabase
        .from('communication_routes')
        .select('*')
        .order('sort_order', { ascending: true });
      setRoutes(refreshed || []);

      showToast?.(`Route "${label}" ${isNew ? 'added' : 'updated'}.`);
      setEditingKey(null);
      resetForm();
    } catch (err) {
      console.error('Failed to save route:', err);
      if (err?.code === '23505') {
        setFormError('A route with that category already exists.');
      } else {
        setFormError('Failed to save. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }, [formData, editingKey, currentUserEmail, showToast, resetForm, routes]);

  const deleteRoute = useCallback(async (route) => {
    if (route.is_default) {
      showToast?.('Cannot delete the default route. Mark another route as default first.');
      return;
    }
    if (!window.confirm(`Delete route "${route.label}"? This also removes any JWT stored for this route. This cannot be undone.`)) return;

    try {
      // Clear the JWT first (deletes the vault secret) if one exists
      if (route.sms_vault_secret_name) {
        const { error: clearErr } = await supabase.rpc('clear_route_ringcentral_jwt', {
          p_category: route.category,
        });
        if (clearErr) throw clearErr;
      }

      const { error } = await supabase
        .from('communication_routes')
        .delete()
        .eq('category', route.category);
      if (error) throw error;

      setRoutes((prev) => prev.filter((r) => r.category !== route.category));
      showToast?.(`Route "${route.label}" deleted.`);
    } catch (err) {
      console.error('Failed to delete route:', err);
      showToast?.('Failed to delete. Please try again.');
    }
  }, [showToast]);

  // ── JWT set/clear handlers ──
  const openJwtEdit = useCallback((route) => {
    setJwtEditingKey(route.category);
    setJwtValue('');
    setJwtError('');
    setEditingKey(null); // close any open edit form
  }, []);

  const cancelJwtEdit = useCallback(() => {
    setJwtEditingKey(null);
    setJwtValue('');
    setJwtError('');
  }, []);

  const saveJwt = useCallback(async () => {
    const trimmed = jwtValue.trim();
    if (!trimmed) { setJwtError('JWT cannot be empty.'); return; }
    // JWTs are 3 base64url segments separated by dots
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
      setJwtError('That does not look like a valid JWT. It should have three parts separated by dots.');
      return;
    }

    setJwtSaving(true);
    setJwtError('');
    try {
      const { error } = await supabase.rpc('set_route_ringcentral_jwt', {
        p_category: jwtEditingKey,
        p_jwt: trimmed,
      });
      if (error) throw error;

      // Refresh the single route to get the updated sms_vault_secret_name
      const { data: refreshed } = await supabase
        .from('communication_routes')
        .select('*')
        .eq('category', jwtEditingKey)
        .single();
      if (refreshed) {
        setRoutes((prev) => prev.map((r) => (r.category === jwtEditingKey ? refreshed : r)));
      }

      showToast?.('JWT saved securely to Supabase Vault.');
      setJwtEditingKey(null);
      setJwtValue('');
    } catch (err) {
      console.error('Failed to save JWT:', err);
      setJwtError(err?.message || 'Failed to save JWT. Please try again.');
    } finally {
      setJwtSaving(false);
    }
  }, [jwtValue, jwtEditingKey, showToast]);

  const clearJwt = useCallback(async (route) => {
    if (!window.confirm(`Remove the JWT for "${route.label}"? After this, sending from this route will fail until a new JWT is provided.`)) return;

    try {
      const { error } = await supabase.rpc('clear_route_ringcentral_jwt', {
        p_category: route.category,
      });
      if (error) throw error;

      setRoutes((prev) => prev.map((r) =>
        r.category === route.category ? { ...r, sms_vault_secret_name: null } : r
      ));
      showToast?.(`JWT cleared for "${route.label}".`);
    } catch (err) {
      console.error('Failed to clear JWT:', err);
      showToast?.('Failed to clear JWT. Please try again.');
    }
  }, [showToast]);

  if (loading) {
    return (
      <SettingsCard title="Communication Routes" description="SMS Routing">
        <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>
      </SettingsCard>
    );
  }

  const configuredCount = routes.filter((r) => r.sms_vault_secret_name && r.sms_from_number).length;

  // ── Render helpers ──
  const renderRouteForm = () => (
    <div style={{
      padding: 16,
      background: '#F8FAFF',
      border: '1px solid #D5DCE6',
      borderRadius: 10,
      marginBottom: 14,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#0F1724', marginBottom: 12 }}>
        {editingKey === '__new__' ? 'Add Communication Route' : `Edit ${formData.label || editingKey}`}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
        <div>
          <label className={forms.fieldLabel}>
            Category *
            {editingKey !== '__new__' && (
              <span style={{ fontWeight: 400, fontSize: 10, color: '#7A8BA0', marginLeft: 6 }}>(cannot be changed)</span>
            )}
          </label>
          <input
            type="text"
            className={forms.fieldInput}
            value={formData.category}
            onChange={(e) => setFormData({ ...formData, category: e.target.value })}
            placeholder="e.g. onboarding"
            disabled={editingKey !== '__new__'}
            style={{ opacity: editingKey !== '__new__' ? 0.6 : 1, fontFamily: 'monospace' }}
            autoFocus={editingKey === '__new__'}
          />
          {editingKey === '__new__' && (
            <div style={{ fontSize: 10, color: '#7A8BA0', marginTop: 4 }}>
              Short code used by code to refer to this route. Lowercase letters, numbers, underscores.
            </div>
          )}
        </div>
        <div>
          <label className={forms.fieldLabel}>Label *</label>
          <input
            type="text"
            className={forms.fieldInput}
            value={formData.label}
            onChange={(e) => setFormData({ ...formData, label: e.target.value })}
            placeholder="e.g. Onboarding (TAS)"
            autoFocus={editingKey !== '__new__'}
          />
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label className={forms.fieldLabel}>Description</label>
        <textarea
          className={forms.fieldInput}
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="When should this route be used? (e.g. 'Caregiver application follow-ups and document requests')"
          rows={2}
          style={{ resize: 'vertical', fontFamily: 'inherit' }}
        />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label className={forms.fieldLabel}>SMS From Phone Number</label>
        <input
          type="tel"
          className={forms.fieldInput}
          value={formData.sms_from_number}
          onChange={(e) => setFormData({ ...formData, sms_from_number: e.target.value })}
          placeholder="e.g. +1 (949) 226-7908"
        />
        <div style={{ fontSize: 10, color: '#7A8BA0', marginTop: 4 }}>
          The RingCentral phone number messages from this route are sent from. Must match the JWT set below.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#0F1724', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={formData.is_default}
            onChange={(e) => setFormData({ ...formData, is_default: e.target.checked })}
          />
          Default route
          <span style={{ fontSize: 10, color: '#7A8BA0' }}>(used when no category is specified)</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#0F1724', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={formData.is_active}
            onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
          />
          Active
        </label>
      </div>

      {formError && (
        <div style={{
          fontSize: 12, color: '#DC4A3A', fontWeight: 600,
          marginBottom: 10, padding: '6px 10px',
          background: '#FEF2F2', borderRadius: 6,
          border: '1px solid #FECACA',
        }}>
          {formError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className={btn.primaryBtn}
          style={{ padding: '8px 18px', fontSize: 13, opacity: saving ? 0.6 : 1 }}
          onClick={saveRoute}
          disabled={saving}
        >
          {saving ? 'Saving...' : (editingKey === '__new__' ? 'Add Route' : 'Save Changes')}
        </button>
        <button
          className={btn.secondaryBtn}
          style={{ padding: '8px 18px', fontSize: 13 }}
          onClick={cancelEdit}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  const renderJwtForm = () => {
    const route = routes.find((r) => r.category === jwtEditingKey);
    if (!route) return null;
    return (
      <div style={{
        padding: 16,
        background: '#FFFBEB',
        border: '1px solid #FDE68A',
        borderRadius: 10,
        marginBottom: 14,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0F1724', marginBottom: 6 }}>
          {route.sms_vault_secret_name ? 'Rotate' : 'Set'} RingCentral JWT — {route.label}
        </div>
        <div style={{ fontSize: 11, color: '#A16207', lineHeight: 1.5, marginBottom: 12 }}>
          <strong>Treat this like a password.</strong> The JWT will be stored encrypted in Supabase Vault.
          Once saved, you will not be able to read it back — only replace it.
          {route.sms_vault_secret_name && ' Saving a new JWT will replace the existing one.'}
        </div>
        <label className={forms.fieldLabel}>JWT Token</label>
        <textarea
          className={forms.fieldInput}
          value={jwtValue}
          onChange={(e) => { setJwtValue(e.target.value); setJwtError(''); }}
          placeholder="Paste the full JWT token here (eyJ...)"
          rows={4}
          style={{ fontFamily: 'monospace', fontSize: 11, resize: 'vertical', wordBreak: 'break-all' }}
          autoFocus
        />
        {jwtError && (
          <div style={{
            fontSize: 12, color: '#DC4A3A', fontWeight: 600,
            marginTop: 8, padding: '6px 10px',
            background: '#FEF2F2', borderRadius: 6,
            border: '1px solid #FECACA',
          }}>
            {jwtError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            className={btn.primaryBtn}
            style={{ padding: '8px 18px', fontSize: 13, opacity: jwtSaving ? 0.6 : 1 }}
            onClick={saveJwt}
            disabled={jwtSaving}
          >
            {jwtSaving ? 'Saving to Vault...' : 'Save JWT to Vault'}
          </button>
          <button
            className={btn.secondaryBtn}
            style={{ padding: '8px 18px', fontSize: 13 }}
            onClick={cancelJwtEdit}
            disabled={jwtSaving}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  };

  return (
    <SettingsCard
      title="Communication Routes"
      description={`${routes.length} route${routes.length !== 1 ? 's' : ''} · ${configuredCount} configured`}
    >
      <div style={{ marginBottom: 12, fontSize: 11, color: '#7A8BA0', lineHeight: 1.5 }}>
        Map categories of outreach (scheduling, onboarding, general) to specific sending identities — phone number and RingCentral JWT.
        JWTs are stored encrypted in Supabase Vault and are write-only from this UI. Nothing sends from these routes yet; the bulk-sms
        edge function will be wired up in a future update. For now this is data entry.
      </div>

      {editingKey !== null && renderRouteForm()}
      {jwtEditingKey !== null && renderJwtForm()}

      {editingKey === null && jwtEditingKey === null && (
        <div style={{ marginBottom: 10 }}>
          <button
            className={btn.primaryBtn}
            style={{ padding: '8px 16px', fontSize: 13 }}
            onClick={startAdd}
          >
            + Add Route
          </button>
        </div>
      )}

      <div style={{ border: '1px solid #E0E4EA', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1.4fr 1.4fr 120px 200px',
          padding: '10px 16px', background: '#F8F9FB',
          fontSize: 10, fontWeight: 700, color: '#7A8BA0',
          textTransform: 'uppercase', letterSpacing: 1,
          borderBottom: '1px solid #E0E4EA',
        }}>
          <span>Route</span>
          <span>Phone Number</span>
          <span>JWT</span>
          <span style={{ textAlign: 'right' }}>Actions</span>
        </div>

        {routes.map((route, i) => {
          const isConfigured = !!(route.sms_vault_secret_name && route.sms_from_number);
          return (
            <div
              key={route.category}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.4fr 1.4fr 120px 200px',
                alignItems: 'center',
                padding: '12px 16px',
                borderBottom: i < routes.length - 1 ? '1px solid #F0F3F7' : 'none',
                background: '#fff',
                opacity: route.is_active === false ? 0.6 : 1,
              }}
            >
              {/* Route label + category */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0F1724', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {route.is_default && (
                    <span title="Default route" style={{ fontSize: 12 }}>⭐</span>
                  )}
                  {route.label}
                </div>
                <div style={{ fontSize: 10, color: '#7A8BA0', fontFamily: 'monospace', marginTop: 2 }}>
                  {route.category}
                </div>
              </div>

              {/* Phone */}
              <div style={{ fontSize: 12, color: '#475569' }}>
                {route.sms_from_number
                  ? formatPhoneDisplay(route.sms_from_number)
                  : <span style={{ color: '#94A3B8' }}>— not set —</span>}
              </div>

              {/* JWT status badge */}
              <div>
                <span style={{
                  display: 'inline-block',
                  padding: '3px 8px',
                  borderRadius: 6,
                  fontSize: 10,
                  fontWeight: 700,
                  background: route.sms_vault_secret_name ? '#F0FDF4' : '#FEF2F2',
                  color: route.sms_vault_secret_name ? '#15803D' : '#A16207',
                  border: `1px solid ${route.sms_vault_secret_name ? '#BBF7D0' : '#FDE68A'}`,
                }}>
                  {route.sms_vault_secret_name ? '✓ Configured' : '✗ Not set'}
                </span>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button
                  className={btn.editBtn}
                  style={{ padding: '5px 10px', fontSize: 11 }}
                  onClick={() => startEdit(route)}
                >
                  Edit
                </button>
                <button
                  className={btn.editBtn}
                  style={{ padding: '5px 10px', fontSize: 11 }}
                  onClick={() => openJwtEdit(route)}
                >
                  {route.sms_vault_secret_name ? 'Rotate JWT' : 'Set JWT'}
                </button>
                {route.sms_vault_secret_name && (
                  <button
                    className={btn.editBtn}
                    style={{ padding: '5px 10px', fontSize: 11, color: '#A16207', borderColor: '#FDE68A' }}
                    onClick={() => clearJwt(route)}
                    title="Remove JWT from this route"
                  >
                    Clear JWT
                  </button>
                )}
                {!route.is_default && (
                  <button
                    className={btn.editBtn}
                    style={{ padding: '5px 10px', fontSize: 11, color: '#DC4A3A', borderColor: '#FECACA' }}
                    onClick={() => deleteRoute(route)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {routes.length === 0 && (
          <div style={{ padding: 28, textAlign: 'center', color: '#7A8BA0', fontSize: 13 }}>
            No routes configured. Click "Add Route" to get started.
          </div>
        )}
      </div>

      {!isConfiguredWarningDismissed(routes) && (
        <div style={{
          marginTop: 14,
          padding: '10px 14px',
          background: '#EEF2FF',
          border: '1px solid #C7D2FE',
          borderRadius: 8,
          fontSize: 11,
          color: '#3730A3',
          lineHeight: 1.5,
        }}>
          <strong>ℹ️ These routes are not yet used for sending.</strong> SMS continues to flow through the global
          RingCentral integration above. Routes will start being used once the edge function is updated in a
          future release.
        </div>
      )}
    </SettingsCard>
  );
}

// Pure helper — keeps the isConfigured banner from rendering in tests where
// routes list is empty. Exported separately so future tests can cover it.
function isConfiguredWarningDismissed(/* routes */) {
  return false; // Always show the warning for now until Step 5 ships.
}

// ─── DocuSign Template Settings ───
function DocuSignSettings({ showToast }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState(null);
  const [testing, setTesting] = useState(false);
  const [docTypes, setDocTypes] = useState([]);

  // Load document types for the documentType dropdown
  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'document_types')
      .single()
      .then(({ data }) => {
        if (data?.value && Array.isArray(data.value) && data.value.length > 0) {
          setDocTypes(data.value);
        }
      });
  }, []);

  // Load templates
  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'docusign_templates')
          .single();
        if (data?.value && Array.isArray(data.value)) {
          setTemplates(data.value);
        }
      } catch (err) {
        // Not configured yet
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Get all tasks for the linked task dropdown
  const allTasks = [];
  const phaseTasks = getPhaseTasks();
  PHASES.forEach((phase) => {
    const tasks = phaseTasks[phase.id] || [];
    tasks.forEach((t) => {
      allTasks.push({ id: t.id, label: t.label, phase: phase.label, phaseIcon: phase.icon });
    });
  });

  // Test connection
  const testConnection = useCallback(async () => {
    setTesting(true);
    try {
      const { data, error } = await supabase.functions.invoke('docusign-integration', {
        body: { action: 'test_connection' },
      });
      if (error) throw error;
      setConnectionStatus(data);
    } catch (err) {
      setConnectionStatus({ connected: false, error: err.message });
    } finally {
      setTesting(false);
    }
  }, []);

  // Save templates
  const saveTemplates = useCallback(async () => {
    const cleaned = draft.filter((t) => t.name.trim() && t.templateId.trim());
    setSaving(true);
    try {
      const { error } = await supabase
        .from('app_settings')
        .upsert(
          { key: 'docusign_templates', value: cleaned, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
      if (error) throw error;
      setTemplates(cleaned);
      setEditing(false);
      showToast?.('DocuSign templates saved successfully!');
    } catch (err) {
      console.error('Failed to save DocuSign templates:', err);
      showToast?.('Failed to save templates. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [draft, showToast]);

  const startEdit = () => {
    setDraft(templates.map((t) => ({ ...t })));
    setEditing(true);
  };

  const addTemplate = () => {
    setDraft((prev) => [...prev, {
      id: 'ds_' + Date.now().toString(36),
      templateId: '',
      name: '',
      taskName: '',
      documentType: '',
    }]);
  };

  const updateDraft = (index, field, value) => {
    setDraft((prev) => prev.map((t, i) => i === index ? { ...t, [field]: value } : t));
  };

  const removeDraft = (index) => {
    setDraft((prev) => prev.filter((_, i) => i !== index));
  };

  if (loading) {
    return (
      <SettingsCard title="DocuSign eSignature" description="Document Signing">
        <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard title="DocuSign eSignature" description="Document Signing">
      {/* Environment setting */}
      <div style={{ marginBottom: 20 }}>
        <EditableSetting
          settingKey="docusign_environment"
          label="Environment"
          helpText="Controls whether API calls go to DocuSign sandbox or production."
          editHelpText="Enter 'sandbox' for testing or 'production' for live signing."
          placeholder="sandbox"
          formatDisplay={(val) => {
            if (val === 'production') return 'Production';
            if (val === '(not configured)') return 'Sandbox (default)';
            return 'Sandbox';
          }}
          showToast={showToast}
        />
      </div>

      {/* Connection test */}
      <div style={{ marginBottom: 20 }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 14px', background: '#F8F9FB', borderRadius: 10,
          border: '1px solid #E0E4EA',
        }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#7A8BA0', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
              Connection Status
            </div>
            {connectionStatus ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: connectionStatus.connected ? '#22C55E' : '#DC2626',
                }} />
                <span style={{
                  fontSize: 12, fontWeight: 600,
                  color: connectionStatus.connected ? '#15803D' : '#DC2626',
                }}>
                  {connectionStatus.connected ? 'Connected' : `Failed: ${connectionStatus.error}`}
                </span>
              </div>
            ) : (
              <span style={{ fontSize: 12, color: '#7A8BA0' }}>Not tested yet</span>
            )}
          </div>
          <button
            className={btn.editBtn}
            style={{ padding: '6px 14px', fontSize: 11, opacity: testing ? 0.5 : 1 }}
            onClick={testConnection}
            disabled={testing}
            onMouseEnter={(e) => { e.target.style.background = '#F0F4FA'; }}
            onMouseLeave={(e) => { e.target.style.background = '#fff'; }}
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
        </div>
      </div>

      {/* Templates */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#7A8BA0', textTransform: 'uppercase', letterSpacing: 1 }}>
            Signing Templates ({templates.length})
          </div>
          {!editing ? (
            <button
              className={btn.editBtn}
              style={{ padding: '5px 12px', fontSize: 11 }}
              onClick={startEdit}
              onMouseEnter={(e) => { e.target.style.background = '#F0F4FA'; }}
              onMouseLeave={(e) => { e.target.style.background = '#fff'; }}
            >
              Edit Templates
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className={btn.primaryBtn}
                style={{ padding: '6px 14px', fontSize: 11, opacity: saving ? 0.6 : 1 }}
                onClick={saveTemplates}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                className={btn.secondaryBtn}
                style={{ padding: '6px 14px', fontSize: 11 }}
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {editing ? (
          <div>
            {draft.map((tmpl, idx) => (
              <div key={tmpl.id} style={{
                display: 'flex', flexDirection: 'column', gap: 8,
                padding: '12px 14px', background: '#F9FAFB', borderRadius: 10,
                border: '1px solid #E2E8F0', marginBottom: 8,
              }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#7A8BA0', fontWeight: 700, minWidth: 20 }}>
                    {idx + 1}.
                  </span>
                  <input
                    type="text"
                    className={forms.fieldInput}
                    style={{ flex: 1, fontSize: 13 }}
                    value={tmpl.name}
                    onChange={(e) => updateDraft(idx, 'name', e.target.value)}
                    placeholder="Template name (e.g. Employment Agreement)"
                  />
                  <button
                    style={{
                      background: 'none', border: 'none', fontSize: 14, cursor: 'pointer',
                      color: '#DC2626', padding: '2px 4px', flexShrink: 0,
                    }}
                    onClick={() => removeDraft(idx)}
                    title="Remove template"
                  >
                    &#10005;
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 8, paddingLeft: 28 }}>
                  <input
                    type="text"
                    className={forms.fieldInput}
                    style={{ flex: 1, fontSize: 12 }}
                    value={tmpl.templateId}
                    onChange={(e) => updateDraft(idx, 'templateId', e.target.value)}
                    placeholder="DocuSign Template ID"
                  />
                  <select
                    className={forms.fieldInput}
                    style={{ flex: 1, fontSize: 12, cursor: 'pointer' }}
                    value={tmpl.taskName || ''}
                    onChange={(e) => updateDraft(idx, 'taskName', e.target.value)}
                  >
                    <option value="">No linked task</option>
                    {PHASES.map((phase) => {
                      const tasks = phaseTasks[phase.id] || [];
                      return tasks.length > 0 ? (
                        <optgroup key={phase.id} label={`${phase.icon} ${phase.label}`}>
                          {tasks.map((t) => (
                            <option key={t.id} value={t.id}>{t.label}</option>
                          ))}
                        </optgroup>
                      ) : null;
                    })}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 8, paddingLeft: 28 }}>
                  <select
                    className={forms.fieldInput}
                    style={{ flex: 1, fontSize: 12, cursor: 'pointer' }}
                    value={tmpl.documentType || ''}
                    onChange={(e) => updateDraft(idx, 'documentType', e.target.value)}
                  >
                    <option value="">No document type (skip SharePoint upload)</option>
                    {docTypes.map((dt) => (
                      <option key={dt.id} value={dt.id}>{dt.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
            <button
              style={{
                width: '100%', padding: 10, border: '2px dashed #D0D9E4', borderRadius: 8,
                background: 'transparent', color: '#2E4E8D', fontSize: 13, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit', marginTop: 4,
              }}
              onClick={addTemplate}
              onMouseEnter={(e) => { e.target.style.background = '#F0F4FA'; }}
              onMouseLeave={(e) => { e.target.style.background = 'transparent'; }}
            >
              + Add Template
            </button>
          </div>
        ) : (
          <div>
            {templates.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px 16px', color: '#7A8BA0', fontSize: 13 }}>
                No templates configured yet. Click "Edit Templates" to add DocuSign templates.
              </div>
            ) : (
              <div style={{ border: '1px solid #E0E4EA', borderRadius: 10, overflow: 'hidden' }}>
                {templates.map((tmpl, i) => (
                  <div key={tmpl.id || i} style={{
                    padding: '12px 16px',
                    borderBottom: i < templates.length - 1 ? '1px solid #F0F3F7' : 'none',
                    background: '#fff',
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0F1724' }}>{tmpl.name}</div>
                    <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <span>ID: {tmpl.templateId?.substring(0, 12)}...</span>
                      {tmpl.taskName && (
                        <span style={{ color: '#15803D' }}>
                          Task: {allTasks.find(t => t.id === tmpl.taskName)?.label || tmpl.taskName}
                        </span>
                      )}
                      {tmpl.documentType && (
                        <span style={{ color: '#2563EB' }}>
                          Doc: {docTypes.find(d => d.id === tmpl.documentType)?.label || tmpl.documentType}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 12, lineHeight: 1.5 }}>
        Create templates in the DocuSign web app, then paste their Template IDs here.
        Optionally link each template to an onboarding task to auto-complete it when signed,
        and set a document type to auto-upload signed documents to SharePoint.
      </div>
    </SettingsCard>
  );
}

// ─── eSign Template Settings ───
function ESignSettings({ showToast }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [docTypes, setDocTypes] = useState([]);
  const [uploading, setUploading] = useState(null);

  // Load document types
  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'document_types')
      .single()
      .then(({ data }) => {
        if (data?.value && Array.isArray(data.value) && data.value.length > 0) {
          setDocTypes(data.value);
        }
      });
  }, []);

  // Load templates from esign_templates table
  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await supabase
          .from('esign_templates')
          .select('*')
          .order('sort_order');
        if (data) setTemplates(data);
      } catch (err) {
        // No templates yet
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Get all tasks for dropdown
  const allTasks = [];
  const phaseTasks = getPhaseTasks();
  PHASES.forEach((phase) => {
    const tasks = phaseTasks[phase.id] || [];
    tasks.forEach((t) => {
      allTasks.push({ id: t.id, label: t.label, phase: phase.label, phaseIcon: phase.icon });
    });
  });

  // Handle PDF upload for a draft template
  const handleFileUpload = useCallback(async (index) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        showToast?.('Only PDF files are accepted for eSign templates.');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        showToast?.('File too large. Maximum 10MB.');
        return;
      }

      setUploading(index);
      try {
        const storagePath = `templates/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const { error: uploadErr } = await supabase.storage
          .from('esign-templates')
          .upload(storagePath, file, { contentType: 'application/pdf' });

        if (uploadErr) throw uploadErr;

        // Generate a signed URL for the visual editor
        let blobUrl = null;
        try {
          const { data: urlData } = await supabase.storage
            .from('esign-templates')
            .createSignedUrl(storagePath, 3600);
          if (urlData?.signedUrl) blobUrl = urlData.signedUrl;
        } catch (_) { /* ok — editor just won't render */ }

        setDraft((prev) => prev.map((t, i) => i === index ? {
          ...t,
          file_name: file.name,
          file_storage_path: storagePath,
          file_page_count: 1,
          _pdfBlobUrl: blobUrl,
          _uploaded: true,
        } : t));
        showToast?.(`Uploaded: ${file.name}`);
      } catch (err) {
        console.error('Upload failed:', err);
        showToast?.(`Upload failed: ${err.message || 'Unknown error'}`);
      } finally {
        setUploading(null);
      }
    };
    input.click();
  }, [showToast]);

  // Save templates
  const saveTemplates = useCallback(async () => {
    const valid = draft.filter((t) => t.name.trim() && t.file_storage_path);
    if (valid.length === 0 && draft.length > 0) {
      showToast?.('Each template needs a name and an uploaded PDF.');
      return;
    }
    setSaving(true);
    try {
      // Upsert each template
      for (let i = 0; i < valid.length; i++) {
        const t = valid[i];
        const row = {
          name: t.name.trim(),
          description: t.description || '',
          file_name: t.file_name,
          file_storage_path: t.file_storage_path,
          file_page_count: t.file_page_count || 1,
          fields: t.fields || [],
          task_name: t.task_name || null,
          document_type: t.document_type || null,
          active: t.active !== false,
          sort_order: i,
          updated_at: new Date().toISOString(),
        };
        if (t.id && !t.id.startsWith('new_')) {
          // Update existing
          await supabase.from('esign_templates').update(row).eq('id', t.id);
        } else {
          // Insert new
          await supabase.from('esign_templates').insert(row);
        }
      }

      // Delete removed templates
      const validIds = valid.filter((t) => t.id && !t.id.startsWith('new_')).map((t) => t.id);
      const existingIds = templates.map((t) => t.id);
      const toDelete = existingIds.filter((id) => !validIds.includes(id));
      if (toDelete.length > 0) {
        await supabase.from('esign_templates').delete().in('id', toDelete);
      }

      // Refresh
      const { data } = await supabase.from('esign_templates').select('*').order('sort_order');
      if (data) setTemplates(data);
      setEditing(false);
      showToast?.('eSign templates saved successfully!');
    } catch (err) {
      console.error('Failed to save eSign templates:', err);
      showToast?.('Failed to save templates. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [draft, templates, showToast]);

  const startEdit = async () => {
    // Generate signed URLs for existing templates so the visual editor can render them
    const drafts = await Promise.all(templates.map(async (t) => {
      let blobUrl = null;
      if (t.file_storage_path && supabase) {
        try {
          const { data } = await supabase.storage
            .from('esign-templates')
            .createSignedUrl(t.file_storage_path, 3600);
          if (data?.signedUrl) blobUrl = data.signedUrl;
        } catch (_) { /* ok */ }
      }
      return { ...t, _pdfBlobUrl: blobUrl };
    }));
    setDraft(drafts);
    setEditing(true);
  };

  const addTemplate = () => {
    setDraft((prev) => [...prev, {
      id: 'new_' + Date.now().toString(36),
      name: '',
      description: '',
      file_name: '',
      file_storage_path: '',
      file_page_count: 1,
      fields: [],
      task_name: '',
      document_type: '',
      active: true,
    }]);
  };

  const updateDraft = (index, field, value) => {
    setDraft((prev) => prev.map((t, i) => i === index ? { ...t, [field]: value } : t));
  };

  const removeDraft = (index) => {
    setDraft((prev) => prev.filter((_, i) => i !== index));
  };

  if (loading) {
    return (
      <SettingsCard title="eSignatures" description="Custom Document Signing">
        <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard title="eSignatures" description="Custom Document Signing">
      {/* Templates */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#7A8BA0', textTransform: 'uppercase', letterSpacing: 1 }}>
            Signing Templates ({templates.length})
          </div>
          {!editing ? (
            <button
              className={btn.editBtn}
              style={{ padding: '5px 12px', fontSize: 11 }}
              onClick={startEdit}
              onMouseEnter={(e) => { e.target.style.background = '#F0F4FA'; }}
              onMouseLeave={(e) => { e.target.style.background = '#fff'; }}
            >
              Edit Templates
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className={btn.primaryBtn}
                style={{ padding: '6px 14px', fontSize: 11, opacity: saving ? 0.6 : 1 }}
                onClick={saveTemplates}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                className={btn.secondaryBtn}
                style={{ padding: '6px 14px', fontSize: 11 }}
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {editing ? (
          <div>
            {draft.map((tmpl, idx) => (
              <div key={tmpl.id} style={{
                display: 'flex', flexDirection: 'column', gap: 8,
                padding: '14px 14px', background: '#F9FAFB', borderRadius: 10,
                border: '1px solid #E2E8F0', marginBottom: 10,
              }}>
                {/* Row 1: Name + Remove */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#7A8BA0', fontWeight: 700, minWidth: 20 }}>
                    {idx + 1}.
                  </span>
                  <input
                    type="text"
                    className={forms.fieldInput}
                    style={{ flex: 1, fontSize: 13 }}
                    value={tmpl.name}
                    onChange={(e) => updateDraft(idx, 'name', e.target.value)}
                    placeholder="Template name (e.g. Employment Agreement)"
                  />
                  <button
                    style={{
                      background: 'none', border: 'none', fontSize: 14, cursor: 'pointer',
                      color: '#DC2626', padding: '2px 4px', flexShrink: 0,
                    }}
                    onClick={() => removeDraft(idx)}
                    title="Remove template"
                  >
                    &#10005;
                  </button>
                </div>

                {/* Row 2: PDF Upload */}
                <div style={{ paddingLeft: 28, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    className={btn.editBtn}
                    style={{ padding: '6px 14px', fontSize: 11, opacity: uploading === idx ? 0.5 : 1 }}
                    onClick={() => handleFileUpload(idx)}
                    disabled={uploading === idx}
                  >
                    {uploading === idx ? 'Uploading...' : tmpl.file_name ? 'Replace PDF' : 'Upload PDF'}
                  </button>
                  {tmpl.file_name && (
                    <span style={{ fontSize: 12, color: '#15803D', fontWeight: 600 }}>
                      {tmpl.file_name}
                    </span>
                  )}
                  {!tmpl.file_name && (
                    <span style={{ fontSize: 11, color: '#DC2626' }}>PDF required</span>
                  )}
                </div>

                {/* Row 3: Linked task + Document type */}
                <div style={{ display: 'flex', gap: 8, paddingLeft: 28 }}>
                  <select
                    className={forms.fieldInput}
                    style={{ flex: 1, fontSize: 12, cursor: 'pointer' }}
                    value={tmpl.task_name || ''}
                    onChange={(e) => updateDraft(idx, 'task_name', e.target.value)}
                  >
                    <option value="">No linked task</option>
                    {PHASES.map((phase) => {
                      const tasks = phaseTasks[phase.id] || [];
                      return tasks.length > 0 ? (
                        <optgroup key={phase.id} label={`${phase.icon} ${phase.label}`}>
                          {tasks.map((t) => (
                            <option key={t.id} value={t.id}>{t.label}</option>
                          ))}
                        </optgroup>
                      ) : null;
                    })}
                  </select>
                  <select
                    className={forms.fieldInput}
                    style={{ flex: 1, fontSize: 12, cursor: 'pointer' }}
                    value={tmpl.document_type || ''}
                    onChange={(e) => updateDraft(idx, 'document_type', e.target.value)}
                  >
                    <option value="">No document type</option>
                    {docTypes.map((dt) => (
                      <option key={dt.id} value={dt.id}>{dt.label}</option>
                    ))}
                  </select>
                </div>

                {/* Row 4: Visual field placement */}
                {tmpl.file_storage_path && (
                  <div style={{ paddingLeft: 28 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#7A8BA0', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                      Place Signing Fields — Click on the PDF to position fields
                    </div>
                    <ESignFieldEditor
                      pdfUrl={tmpl._pdfBlobUrl || null}
                      fields={tmpl.fields || []}
                      onFieldsChange={(newFields) => updateDraft(idx, 'fields', newFields)}
                    />
                  </div>
                )}
                {!tmpl.file_storage_path && (
                  <div style={{ paddingLeft: 28, fontSize: 12, color: '#7A8BA0', fontStyle: 'italic' }}>
                    Upload a PDF to place signing fields visually.
                  </div>
                )}
              </div>
            ))}
            <button
              style={{
                width: '100%', padding: 10, border: '2px dashed #D0D9E4', borderRadius: 8,
                background: 'transparent', color: '#2E4E8D', fontSize: 13, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit', marginTop: 4,
              }}
              onClick={addTemplate}
              onMouseEnter={(e) => { e.target.style.background = '#F0F4FA'; }}
              onMouseLeave={(e) => { e.target.style.background = 'transparent'; }}
            >
              + Add Template
            </button>
          </div>
        ) : (
          <div>
            {templates.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px 16px', color: '#7A8BA0', fontSize: 13 }}>
                No templates configured yet. Click "Edit Templates" to upload PDF templates and define signing fields.
              </div>
            ) : (
              <div style={{ border: '1px solid #E0E4EA', borderRadius: 10, overflow: 'hidden' }}>
                {templates.map((tmpl, i) => (
                  <div key={tmpl.id || i} style={{
                    padding: '12px 16px',
                    borderBottom: i < templates.length - 1 ? '1px solid #F0F3F7' : 'none',
                    background: '#fff',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#0F1724' }}>{tmpl.name}</div>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                        background: tmpl.active ? '#DCFCE7' : '#F3F4F6',
                        color: tmpl.active ? '#15803D' : '#6B7280',
                      }}>
                        {tmpl.active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <span>PDF: {tmpl.file_name}</span>
                      <span>Fields: {(tmpl.fields || []).length}</span>
                      {tmpl.task_name && (
                        <span style={{ color: '#15803D' }}>
                          Task: {allTasks.find(t => t.id === tmpl.task_name)?.label || tmpl.task_name}
                        </span>
                      )}
                      {tmpl.document_type && (
                        <span style={{ color: '#2563EB' }}>
                          Doc: {docTypes.find(d => d.id === tmpl.document_type)?.label || tmpl.document_type}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 12, lineHeight: 1.5 }}>
        Upload PDF documents and define where signatures, initials, and dates should be placed.
        Optionally link each template to an onboarding task (auto-completes when signed)
        and a document type (auto-uploads signed copy to SharePoint).
      </div>
    </SettingsCard>
  );
}

// ─── RingCentral Webhook Status ───
// Shows per-route subscription status. Each row in `communication_routes`
// gets its own RingCentral webhook subscription (main line, Onboarding,
// Scheduling, …) so inbound SMS to any of our numbers is captured.
function WebhookStatus({ showToast }) {
  const [routes, setRoutes] = useState(null); // null = loading, [] = none, [{...}] = loaded
  const [loading, setLoading] = useState(false);

  const loadRoutes = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('communication_routes')
        .select('category, label, is_active, subscription_id, subscription_expires_at, subscription_last_error, subscription_synced_at')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      setRoutes(data || []);
    } catch {
      setRoutes([]);
    }
  }, []);

  useEffect(() => {
    loadRoutes();
  }, [loadRoutes]);

  const handleSubscribe = async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL || 'https://zocrnurvazyxdpyqimgj.supabase.co'}/functions/v1/ringcentral-webhook?action=subscribe`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({}),
        }
      );
      const result = await resp.json();
      await loadRoutes();
      if (result.summary) {
        const { subscribed, total, failed } = result.summary;
        if (failed > 0) {
          showToast?.(`${subscribed} of ${total} routes subscribed — ${failed} failed. Check route errors below.`);
        } else {
          showToast?.(`All ${subscribed} route${subscribed === 1 ? '' : 's'} subscribed successfully.`);
        }
      } else if (result.error) {
        showToast?.(`Failed: ${result.error}`);
      }
    } catch (err) {
      showToast?.(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const subscribedCount = (routes || []).filter((r) => r.subscription_id && !r.subscription_last_error).length;
  const totalCount = (routes || []).length;
  const allHealthy = totalCount > 0 && subscribedCount === totalCount;

  return (
    <div style={{ marginTop: 20, borderTop: '1px solid #E0E4EA', paddingTop: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 14px', background: '#F8F9FB', borderRadius: 10,
        border: '1px solid #E0E4EA',
      }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#7A8BA0', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
            Inbound SMS Webhook
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: allHealthy ? '#22C55E' : totalCount === 0 ? '#D5DCE6' : '#F59E0B',
              display: 'inline-block',
            }} />
            <span style={{ fontSize: 12, color: allHealthy ? '#15803D' : totalCount === 0 ? '#7A8BA0' : '#B45309', fontWeight: 500 }}>
              {routes === null
                ? 'Checking...'
                : totalCount === 0
                  ? 'No active routes'
                  : `${subscribedCount} of ${totalCount} route${totalCount === 1 ? '' : 's'} subscribed`}
            </span>
          </div>
        </div>
        <button
          className={btn.primaryBtn}
          style={{ padding: '6px 14px', fontSize: 12, opacity: loading ? 0.6 : 1 }}
          onClick={handleSubscribe}
          disabled={loading}
        >
          {loading ? 'Setting up...' : allHealthy ? 'Refresh' : 'Enable / Retry'}
        </button>
      </div>

      {routes && routes.length > 0 && (
        <div style={{ marginTop: 10, border: '1px solid #E0E4EA', borderRadius: 8, overflow: 'hidden' }}>
          {routes.map((r, idx) => {
            const ok = r.subscription_id && !r.subscription_last_error;
            return (
              <div
                key={r.category}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderTop: idx === 0 ? 'none' : '1px solid #E0E4EA',
                  background: '#fff',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: ok ? '#22C55E' : r.subscription_last_error ? '#EF4444' : '#D5DCE6',
                    flexShrink: 0,
                  }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#1F2937' }}>{r.label}</div>
                    <div style={{ fontSize: 11, color: r.subscription_last_error ? '#B91C1C' : '#7A8BA0', marginTop: 2 }}>
                      {r.subscription_last_error
                        ? `Error: ${r.subscription_last_error}`
                        : r.subscription_id
                          ? `Subscribed${r.subscription_expires_at ? ` • expires ${new Date(r.subscription_expires_at).toLocaleString()}` : ''}`
                          : 'Not subscribed yet'}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 8, lineHeight: 1.5 }}>
        Each active communication route needs its own webhook subscription so that inbound SMS to that number is logged and triggers automations. Renewal runs automatically every night; click Refresh to re-subscribe immediately after adding a new route or JWT.
      </div>
    </div>
  );
}

// ─── AI Business Context Settings ───
function BusinessContextSettings({ showToast }) {
  const [value, setValue] = useState('');
  const [editValue, setEditValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'ai_business_context')
          .single();
        if (error) throw error;
        setValue(typeof data?.value === 'string' ? data.value : '');
      } catch {
        setValue('');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const startEdit = useCallback(() => {
    setEditValue(value);
    setEditing(true);
  }, [value]);

  const save = useCallback(async () => {
    const trimmed = editValue.trim();
    setSaving(true);
    try {
      const { error } = await supabase
        .from('app_settings')
        .upsert(
          { key: 'ai_business_context', value: trimmed, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
      if (error) throw error;
      setValue(trimmed);
      setEditing(false);
      showToast?.('AI business context updated!');
    } catch (err) {
      console.error('Failed to save business context:', err);
      showToast?.('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [editValue, showToast]);

  if (loading) {
    return (
      <SettingsCard title="AI Business Context" description="Message Classifier Knowledge">
        <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>
      </SettingsCard>
    );
  }

  const hasContent = value && value.length > 0;
  const preview = hasContent ? (value.length > 200 ? value.slice(0, 200) + '...' : value) : '(not configured)';

  return (
    <SettingsCard title="AI Business Context" description="Message Classifier Knowledge">
      {/* Status */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
        padding: '10px 14px',
        background: hasContent ? '#F0FDF4' : '#FFFBEB',
        borderRadius: 10,
        border: `1px solid ${hasContent ? '#BBF7D0' : '#FDE68A'}`,
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: hasContent ? '#22C55E' : '#EAB308',
        }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: hasContent ? '#15803D' : '#A16207' }}>
          {hasContent ? 'Configured' : 'Not configured — classifier uses generic responses'}
        </span>
      </div>

      {!editing ? (
        <div>
          <div style={{
            fontSize: 13, color: '#0F1724', whiteSpace: 'pre-wrap', lineHeight: 1.6,
            padding: '12px 14px', background: '#F8F9FB', borderRadius: 10,
            border: '1px solid #E0E4EA', marginBottom: 12,
          }}>
            {preview}
          </div>
          <button
            className={btn.editBtn}
            onClick={startEdit}
            onMouseEnter={(e) => { e.target.style.background = '#F0F4FA'; }}
            onMouseLeave={(e) => { e.target.style.background = '#fff'; }}
          >
            {hasContent ? 'Edit' : 'Set Up'}
          </button>
          <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 10, lineHeight: 1.5 }}>
            This context is included when the AI classifier drafts responses to inbound messages.
            Add your office address, orientation schedule, document requirements, and response style
            so the AI gives specific answers instead of generic placeholders.
          </div>
        </div>
      ) : (
        <div>
          <label className={forms.fieldLabel}>Business Context</label>
          <textarea
            className={forms.fieldInput}
            style={{ minHeight: 200, fontFamily: 'inherit', lineHeight: 1.6, resize: 'vertical' }}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            placeholder={'Tremendous Care — Home Care Staffing Agency\nOffice: 123 Main St, Suite 100, Irvine CA 92618\nOrientation Schedule: Every Tuesday and Thursday, 9am-12pm\n\nDocument Requirements:\n- Valid HCA registration\n- Driver\'s license\n- TB test (within 1 year)\n- CPR/First Aid certification\n- Live Scan fingerprinting\n\nResponse Style: Warm, professional, concise. Use first names. SMS under 160 chars.'}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              className={btn.primaryBtn}
              style={{ padding: '9px 20px', fontSize: 13, opacity: saving ? 0.6 : 1 }}
              onClick={save}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              className={btn.secondaryBtn}
              style={{ padding: '9px 20px', fontSize: 13 }}
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </SettingsCard>
  );
}

// ─── Main Admin Settings Page ───
export function AdminSettings({ showToast, currentUserEmail }) {
  return (
    <div>
      {/* Header */}
      <div className={layout.header}>
        <div>
          <h1 className={layout.pageTitle}>Settings</h1>
          <p className={layout.pageSubtitle}>Manage team roles and portal configuration</p>
        </div>
      </div>

      {/* Agent Performance */}
      <div style={{ marginBottom: 20 }}>
        <CollapsibleCard title="Agent Performance" description="AI Activity & Success Metrics">
          <div style={{ padding: '20px 24px' }}>
            <AgentPerformance />
          </div>
        </CollapsibleCard>
      </div>

      {/* User Access & Roles (login permissions) */}
      <div style={{ marginBottom: 20 }}>
        <UserManagement showToast={showToast} currentUserEmail={currentUserEmail} />
      </div>

      {/* Team Members Directory (employee info) */}
      <div style={{ marginBottom: 20 }}>
        <TeamMembersManagement showToast={showToast} currentUserEmail={currentUserEmail} />
      </div>

      {/* AI Autonomy Levels */}
      <div style={{ marginBottom: 20 }}>
        <AutonomySettings showToast={showToast} />
      </div>

      {/* AI Business Context */}
      <div style={{ marginBottom: 20 }}>
        <BusinessContextSettings showToast={showToast} />
      </div>

      {/* Pre-Screening Surveys */}
      <div style={{ marginBottom: 20 }}>
        <SurveySettings showToast={showToast} />
      </div>

      {/* Automation Engine */}
      <div style={{ marginBottom: 20 }}>
        <AutomationSettings showToast={showToast} currentUserEmail={currentUserEmail} />
      </div>

      {/* Action Item Rules */}
      <div style={{ marginBottom: 20 }}>
        <ActionItemRuleSettings showToast={showToast} currentUserEmail={currentUserEmail} />
      </div>

      {/* Outlook Email Integration */}
      <div style={{ marginBottom: 20 }}>
        <SettingsCard title="Outlook Email Integration" description="Microsoft 365">
          <EditableSetting
            settingKey="outlook_mailbox"
            label="Active Mailbox"
            helpText="The AI assistant reads and sends emails from this mailbox via Microsoft Graph API."
            editHelpText="This must be a Microsoft 365 mailbox your Azure AD app has permissions to access."
            placeholder="e.g. recruiting@tremendouscareca.com"
            validate={validateEmail}
            showToast={showToast}
          />
        </SettingsCard>
      </div>

      {/* Outlook Calendar Integration */}
      <div style={{ marginBottom: 20 }}>
        <SettingsCard title="Outlook Calendar Integration" description="Microsoft 365">
          <EditableSetting
            settingKey="calendar_mailbox"
            label="Calendar Mailbox"
            helpText="The AI assistant reads calendar events and checks availability from this mailbox. If not set, uses the email mailbox above."
            editHelpText="This must be a Microsoft 365 mailbox with Calendars.Read permissions granted in Azure AD."
            placeholder="e.g. kevinnash@tremendouscareca.com"
            validate={validateEmail}
            showToast={showToast}
          />
        </SettingsCard>
      </div>

      {/* RingCentral Integration */}
      <div style={{ marginBottom: 20 }}>
        <SettingsCard title="RingCentral SMS & Calls" description="Voice & Messaging">
          <EditableSetting
            settingKey="ringcentral_from_number"
            label="From Phone Number"
            helpText="SMS messages and call logs use this number as the company line."
            editHelpText="Enter a US phone number in any format (e.g. +19498732367 or 949-873-2367). Must be a number assigned to your RingCentral account."
            placeholder="e.g. +19498732367"
            validate={validatePhoneNumber}
            formatDisplay={formatPhoneDisplay}
            showToast={showToast}
          />
          <WebhookStatus showToast={showToast} />
        </SettingsCard>
      </div>

      {/* Communication Routes (role-based SMS routing — data entry only for now) */}
      <div style={{ marginBottom: 20 }}>
        <CommunicationRoutesManagement showToast={showToast} currentUserEmail={currentUserEmail} />
      </div>

      {/* eSignatures (Custom) */}
      <div style={{ marginBottom: 20 }}>
        <ESignSettings showToast={showToast} />
      </div>

      {/* DocuSign eSignature Integration (Legacy) */}
      <div style={{ marginBottom: 20 }}>
        <DocuSignSettings showToast={showToast} />
      </div>

      {/* Other Integrations (read-only info) */}
      <div style={{
        fontSize: 10, fontWeight: 700, color: '#7A8BA0', textTransform: 'uppercase',
        letterSpacing: 1.8, marginBottom: 12, marginTop: 28,
      }}>
        Other Integrations
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
        <IntegrationInfoCard
          title="SharePoint Documents"
          status="connected"
          details="Caregiver document upload, download, and management via Microsoft Graph API. Configured via environment secrets."
        />
        <IntegrationInfoCard
          title="DocuSign eSignature"
          status="connected"
          details="Document signing via DocuSign REST API. Templates and environment configured above. Secrets managed via Supabase environment."
        />
      </div>
    </div>
  );
}
