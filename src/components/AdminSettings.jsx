import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import btn from '../styles/buttons.module.css';
import forms from '../styles/forms.module.css';
import cards from '../styles/cards.module.css';
import layout from '../styles/layout.module.css';
import { AutomationSettings } from './AutomationSettings';

// ─── Settings Section Card ───
function SettingsCard({ title, description, children }) {
  return (
    <div className={cards.profileCard}>
      <div className={cards.profileCardHeader}>
        <h3 className={cards.profileCardTitle}>{title}</h3>
        {description && (
          <span style={{ fontSize: 12, color: '#7A8BA0', fontWeight: 500 }}>{description}</span>
        )}
      </div>
      <div style={{ padding: '20px 24px' }}>
        {children}
      </div>
    </div>
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
      <SettingsCard title="Team Members" description="Roles & Access">
        <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>
      </SettingsCard>
    );
  }

  const admins = users.filter((u) => u.role === 'admin');
  const members = users.filter((u) => u.role === 'member');

  return (
    <SettingsCard title="Team Members" description={`${users.length} user${users.length !== 1 ? 's' : ''}`}>
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

      {/* User Management */}
      <div style={{ marginBottom: 20 }}>
        <UserManagement showToast={showToast} currentUserEmail={currentUserEmail} />
      </div>

      {/* Automation Engine */}
      <div style={{ marginBottom: 20 }}>
        <AutomationSettings showToast={showToast} currentUserEmail={currentUserEmail} />
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
        </SettingsCard>
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
      </div>
    </div>
  );
}
