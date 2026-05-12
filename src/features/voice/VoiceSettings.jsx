// ─────────────────────────────────────────────────────────────────
// Voice / CTI Phase 1 PR 3 — admin Voice & Calls settings
//
// Two panels under one CollapsibleCard inside AdminSettings:
//   1. Org voice config (recording, screen-pop, transcription
//      provider, auth route category) — backed by
//      communication_voice_config.
//   2. Per-user RingCentral extension binding — backed by
//      org_memberships.ringcentral_extension_id. The unique
//      constraint per (org_id, extension_id) (PR 1) prevents
//      double-binding; we'll drop that in PR 4 to support on-call
//      rotations.
//
// Admin-only. Tenant isolation + write-gate enforced by RLS at the
// DB layer; the UI just hides the section when not isAdmin.
// ─────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useApp } from '../../shared/context/AppContext';
import { CollapsibleCard } from '../../shared/components/CollapsibleCard';
import styles from './voice.module.css';

const TRANSCRIPTION_OPTIONS = [
  { value: 'ringcentral_native', label: 'RingCentral Native (RingSense)' },
  { value: 'whisper', label: 'OpenAI Whisper' },
  { value: 'both', label: 'Native, fall back to Whisper' },
];

function useVoiceConfig(orgId) {
  const [config, setConfig] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    const [{ data: cfgRow }, { data: routeRows }] = await Promise.all([
      supabase
        .from('communication_voice_config')
        .select('*')
        .eq('org_id', orgId)
        .maybeSingle(),
      supabase
        .from('communication_routes')
        .select('category, label, is_active')
        .eq('is_active', true)
        .order('sort_order'),
    ]);
    setConfig(cfgRow);
    setRoutes(routeRows || []);
    setLoaded(true);
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  return { config, routes, loaded, reload: load };
}

function ConfigPanel({ orgId, showToast }) {
  const { config, routes, loaded, reload } = useVoiceConfig(orgId);
  const [saving, setSaving] = useState(false);

  const update = useCallback(
    async (patch) => {
      if (!orgId || saving) return;
      setSaving(true);
      const { error } = await supabase
        .from('communication_voice_config')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('org_id', orgId);
      setSaving(false);
      if (error) {
        showToast(`Update failed: ${error.message}`);
      } else {
        reload();
        showToast('Voice settings updated');
      }
    },
    [orgId, saving, reload, showToast],
  );

  if (!loaded) return <div className={styles.adminSectionHint}>Loading voice settings…</div>;
  if (!config) {
    return (
      <div className={styles.adminSectionHint}>
        No voice config row yet for this org. Insert one via SQL to enable Voice features.
      </div>
    );
  }

  return (
    <div>
      <div className={styles.adminRow}>
        <span className={styles.adminRowLabel}>Call recording</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={!!config.recording_enabled}
            onChange={(e) => update({ recording_enabled: e.target.checked })}
            disabled={saving}
          />
          <span style={{ fontSize: 13, color: '#7A8BA0' }}>
            {config.recording_enabled ? 'Recording every call' : 'Off'}
          </span>
        </label>
      </div>

      <div className={styles.adminRow}>
        <span className={styles.adminRowLabel}>Screen-pop on incoming calls</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={!!config.screen_pop_enabled}
            onChange={(e) => update({ screen_pop_enabled: e.target.checked })}
            disabled={saving}
          />
          <span style={{ fontSize: 13, color: '#7A8BA0' }}>
            {config.screen_pop_enabled ? 'On' : 'Off'}
          </span>
        </label>
      </div>

      <div className={styles.adminRow}>
        <span className={styles.adminRowLabel}>Auto-navigate to caller profile on answer</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={!!config.auto_navigate_on_answer_default}
            onChange={(e) =>
              update({ auto_navigate_on_answer_default: e.target.checked })
            }
            disabled={saving}
          />
          <span style={{ fontSize: 13, color: '#7A8BA0' }}>
            (Default — users can override in their preferences once that ships)
          </span>
        </label>
      </div>

      <div className={styles.adminRow}>
        <span className={styles.adminRowLabel}>Transcription provider</span>
        <select
          value={config.transcription_provider}
          onChange={(e) => update({ transcription_provider: e.target.value })}
          disabled={saving}
          className={styles.adminBindInput}
          style={{ maxWidth: 280 }}
        >
          {TRANSCRIPTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.adminRow}>
        <span className={styles.adminRowLabel}>Auth route (JWT source)</span>
        <select
          value={config.auth_route_category || ''}
          onChange={(e) => update({ auth_route_category: e.target.value || null })}
          disabled={saving}
          className={styles.adminBindInput}
          style={{ maxWidth: 280 }}
        >
          <option value="">(none)</option>
          {routes.map((r) => (
            <option key={r.category} value={r.category}>
              {r.label} ({r.category})
            </option>
          ))}
        </select>
      </div>

      {config.webhook_subscription_id && (
        <div className={styles.adminRow}>
          <span className={styles.adminRowLabel}>Telephony Sessions subscription</span>
          <span style={{ fontSize: 12, color: '#7A8BA0', fontFamily: 'monospace' }}>
            {config.webhook_subscription_id.slice(0, 12)}…
            {config.webhook_subscription_expires_at && (
              <span style={{ marginLeft: 12 }}>
                expires{' '}
                {new Date(config.webhook_subscription_expires_at).toLocaleDateString()}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function ExtensionBindings({ orgId, showToast }) {
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    // Single SECURITY DEFINER RPC bridges org_memberships (user_id) →
    // auth.users (email) → team_members (display_name). Admin-only;
    // returns empty for non-admins. See migration
    // 20260512010000_voice_get_org_voice_bindings_rpc.sql.
    const { data, error } = await supabase.rpc('get_org_voice_bindings');
    if (error) {
      showToast(`Load failed: ${error.message}`);
      return;
    }
    setRows(
      (data || []).map((m) => ({
        user_id: m.user_id,
        role: m.role,
        ringcentral_extension_id: m.ringcentral_extension_id,
        email: m.email || '(unknown)',
        displayName: m.display_name || null,
      })),
    );
    setLoaded(true);
  }, [orgId, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const saveOne = useCallback(
    async (row) => {
      const draftValue =
        drafts[row.user_id] !== undefined
          ? drafts[row.user_id]
          : row.ringcentral_extension_id || '';
      const trimmed = draftValue.trim();
      setSavingId(row.user_id);
      const { error } = await supabase
        .from('org_memberships')
        .update({ ringcentral_extension_id: trimmed || null })
        .eq('org_id', orgId)
        .eq('user_id', row.user_id);
      setSavingId(null);
      if (error) {
        showToast(`Save failed: ${error.message}`);
        return;
      }
      showToast(trimmed ? 'Extension bound' : 'Extension unbound');
      setDrafts((d) => {
        const next = { ...d };
        delete next[row.user_id];
        return next;
      });
      load();
    },
    [drafts, orgId, load, showToast],
  );

  if (!loaded) return <div className={styles.adminSectionHint}>Loading…</div>;
  if (rows.length === 0) {
    return <div className={styles.adminSectionHint}>No staff users found.</div>;
  }

  return (
    <div>
      <p className={styles.adminSectionHint}>
        Bind each staff user to their RingCentral extension ID (the numeric
        ID from the user's URL in service.ringcentral.com, e.g.{' '}
        <code>792493017</code>). When a call rings their extension, the
        screen-pop fires on their portal.
      </p>
      <table className={styles.adminBindTable}>
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>RC Extension ID</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const current = row.ringcentral_extension_id || '';
            const draft =
              drafts[row.user_id] !== undefined ? drafts[row.user_id] : current;
            const dirty = draft !== current;
            return (
              <tr key={row.user_id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{row.displayName || row.email}</div>
                  {row.displayName && (
                    <div style={{ fontSize: 11, color: '#7A8BA0' }}>{row.email}</div>
                  )}
                </td>
                <td style={{ textTransform: 'capitalize' }}>{row.role}</td>
                <td>
                  <input
                    type="text"
                    className={styles.adminBindInput}
                    value={draft}
                    placeholder="e.g. 792493017"
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [row.user_id]: e.target.value }))
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className={styles.adminSaveBtn}
                    onClick={() => saveOne(row)}
                    disabled={!dirty || savingId === row.user_id}
                  >
                    {savingId === row.user_id ? 'Saving…' : 'Save'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function VoiceSettings({ showToast }) {
  const { currentOrgId, isAdmin } = useApp();
  if (!isAdmin) return null;
  return (
    <CollapsibleCard
      title="Voice & Calls"
      description="Screen-pop, recording, transcription, extension bindings"
    >
      <div style={{ padding: '20px 24px' }}>
        <h4 className={styles.adminSectionTitle}>Org configuration</h4>
        <ConfigPanel orgId={currentOrgId} showToast={showToast} />

        <h4 className={styles.adminSectionTitle} style={{ marginTop: 24 }}>
          RingCentral extension bindings
        </h4>
        <ExtensionBindings orgId={currentOrgId} showToast={showToast} />
      </div>
    </CollapsibleCard>
  );
}
