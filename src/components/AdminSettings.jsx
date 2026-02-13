import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { styles } from '../styles/theme';

// ─── Settings Section Card ───
function SettingsCard({ title, description, children }) {
  return (
    <div style={styles.profileCard}>
      <div style={styles.profileCardHeader}>
        <h3 style={styles.profileCardTitle}>{title}</h3>
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

// ─── Outlook Mailbox Setting ───
function OutlookMailboxSetting({ showToast }) {
  const [mailbox, setMailbox] = useState('');
  const [editValue, setEditValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load current mailbox on mount
  useEffect(() => {
    const load = async () => {
      try {
        const { data, error: fetchErr } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'outlook_mailbox')
          .single();

        if (fetchErr) throw fetchErr;
        const val = data?.value || '';
        setMailbox(typeof val === 'string' ? val : String(val));
      } catch (err) {
        console.error('Failed to load mailbox setting:', err);
        setMailbox('(not configured)');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const startEdit = useCallback(() => {
    setEditValue(mailbox === '(not configured)' ? '' : mailbox);
    setEditing(true);
    setError('');
  }, [mailbox]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setError('');
  }, []);

  const validateEmail = (email) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const saveMailbox = useCallback(async () => {
    const trimmed = editValue.trim();
    if (!trimmed) {
      setError('Email address is required.');
      return;
    }
    if (!validateEmail(trimmed)) {
      setError('Please enter a valid email address.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const { error: upsertErr } = await supabase
        .from('app_settings')
        .upsert(
          { key: 'outlook_mailbox', value: trimmed, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );

      if (upsertErr) throw upsertErr;

      setMailbox(trimmed);
      setEditing(false);
      showToast?.('Outlook mailbox updated successfully!');
    } catch (err) {
      console.error('Failed to save mailbox:', err);
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [editValue, showToast]);

  if (loading) {
    return <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading...</div>;
  }

  return (
    <div>
      {/* Status indicator */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
        padding: '10px 14px', background: '#F0FDF4', borderRadius: 10, border: '1px solid #BBF7D0',
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: mailbox && mailbox !== '(not configured)' ? '#22C55E' : '#EAB308',
        }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#15803D' }}>
          {mailbox && mailbox !== '(not configured)' ? 'Connected' : 'Not configured'}
        </span>
      </div>

      {/* Display mode */}
      {!editing ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#7A8BA0', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>
              Active Mailbox
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#0F1724' }}>
              {mailbox}
            </div>
            <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 4 }}>
              The AI assistant reads and sends emails from this mailbox via Microsoft Graph API.
            </div>
          </div>
          <button
            style={styles.editBtn}
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
          <label style={styles.fieldLabel}>Mailbox Email Address</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <input
                type="email"
                style={{
                  ...styles.fieldInput,
                  borderColor: error ? '#DC4A3A' : '#E0E4EA',
                }}
                value={editValue}
                onChange={(e) => { setEditValue(e.target.value); setError(''); }}
                placeholder="e.g. recruiting@tremendouscareca.com"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') saveMailbox(); if (e.key === 'Escape') cancelEdit(); }}
              />
              {error && (
                <div style={{ fontSize: 12, color: '#DC4A3A', fontWeight: 600, marginTop: 6 }}>{error}</div>
              )}
              <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 6 }}>
                This must be a Microsoft 365 mailbox your Azure AD app has permissions to access.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              style={{
                ...styles.primaryBtn,
                padding: '9px 20px',
                fontSize: 13,
                opacity: saving ? 0.6 : 1,
              }}
              onClick={saveMailbox}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              style={{ ...styles.secondaryBtn, padding: '9px 20px', fontSize: 13 }}
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

// ─── Integration Info Card (read-only) ───
function IntegrationInfoCard({ title, status, details }) {
  const isConnected = status === 'connected';
  return (
    <div style={styles.profileCard}>
      <div style={{
        ...styles.profileCardHeader,
        borderBottom: 'none',
        paddingBottom: 20,
      }}>
        <div>
          <h3 style={{ ...styles.profileCardTitle, marginBottom: 4 }}>{title}</h3>
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

// ─── Main Admin Settings Page ───
export function AdminSettings({ showToast }) {
  return (
    <div>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>Settings</h1>
          <p style={styles.pageSubtitle}>Manage integrations and portal configuration</p>
        </div>
      </div>

      {/* Outlook Email Integration */}
      <div style={{ marginBottom: 20 }}>
        <SettingsCard
          title="Outlook Email Integration"
          description="Microsoft 365"
        >
          <OutlookMailboxSetting showToast={showToast} />
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
          title="RingCentral SMS & Calls"
          status="connected"
          details="SMS send/receive and call log access via RingCentral API. Configured via environment secrets."
        />
        <IntegrationInfoCard
          title="SharePoint Documents"
          status="connected"
          details="Caregiver document upload, download, and management via Microsoft Graph API. Configured via environment secrets."
        />
      </div>
    </div>
  );
}
