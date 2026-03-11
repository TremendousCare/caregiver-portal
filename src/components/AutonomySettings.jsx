import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import cards from '../styles/cards.module.css';
import btn from '../styles/buttons.module.css';

const LEVEL_OPTIONS = [
  { value: 'L1', label: 'L1 — Suggest', description: 'Shows in notification center only' },
  { value: 'L2', label: 'L2 — Confirm', description: 'Shows with Approve/Reject buttons' },
  { value: 'L3', label: 'L3 — Notify', description: 'Executes immediately, shows notification' },
  { value: 'L4', label: 'L4 — Auto', description: 'Executes silently, log only' },
];

const ACTION_LABELS = {
  send_sms: 'Send SMS Reply',
  send_email: 'Send Email Reply',
  update_phase: 'Update Phase',
  complete_task: 'Complete Task',
  add_note: 'Add Note',
};

const ENTITY_LABELS = {
  caregiver: 'Caregiver',
  client: 'Client',
};

export function AutonomySettings({ showToast }) {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);

  const fetchConfigs = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('autonomy_config')
        .select('*')
        .eq('context', 'inbound_routing')
        .order('action_type')
        .order('entity_type');

      if (error) throw error;
      setConfigs(data || []);
    } catch (err) {
      console.error('Failed to load autonomy config:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  const handleLevelChange = useCallback(async (configId, newLevel) => {
    setSaving(configId);
    try {
      const { error } = await supabase
        .from('autonomy_config')
        .update({
          autonomy_level: newLevel,
          updated_at: new Date().toISOString(),
          updated_by: 'admin',
        })
        .eq('id', configId);

      if (error) throw error;

      setConfigs(prev =>
        prev.map(c => c.id === configId ? { ...c, autonomy_level: newLevel } : c)
      );
      showToast?.('Autonomy level updated');
    } catch (err) {
      console.error('Failed to update autonomy level:', err);
      showToast?.('Failed to update. Please try again.');
    } finally {
      setSaving(null);
    }
  }, [showToast]);

  const handleResetCounters = useCallback(async (configId) => {
    setSaving(configId);
    try {
      const { error } = await supabase
        .from('autonomy_config')
        .update({
          consecutive_approvals: 0,
          total_approvals: 0,
          total_rejections: 0,
          updated_at: new Date().toISOString(),
          updated_by: 'admin',
        })
        .eq('id', configId);

      if (error) throw error;

      setConfigs(prev =>
        prev.map(c =>
          c.id === configId
            ? { ...c, consecutive_approvals: 0, total_approvals: 0, total_rejections: 0 }
            : c
        )
      );
      showToast?.('Counters reset');
    } catch (err) {
      console.error('Failed to reset counters:', err);
    } finally {
      setSaving(null);
    }
  }, [showToast]);

  if (loading) {
    return (
      <div className={cards.profileCard}>
        <div className={cards.profileCardHeader}>
          <h3 className={cards.profileCardTitle}>AI Autonomy Levels</h3>
        </div>
        <div style={{ padding: 24, color: '#7A8BA0', fontSize: 13 }}>Loading...</div>
      </div>
    );
  }

  // Group by action_type for display
  const grouped = {};
  for (const config of configs) {
    if (!grouped[config.action_type]) {
      grouped[config.action_type] = [];
    }
    grouped[config.action_type].push(config);
  }

  return (
    <div className={cards.profileCard}>
      <div className={cards.profileCardHeader}>
        <h3 className={cards.profileCardTitle}>AI Autonomy Levels</h3>
        <span style={{ fontSize: 12, color: '#7A8BA0', fontWeight: 500 }}>
          Inbound Message Routing
        </span>
      </div>

      <div style={{ padding: '16px 24px 8px' }}>
        <div style={{
          padding: '10px 14px',
          background: '#F0F9FF',
          borderRadius: 10,
          border: '1px solid #BAE6FD',
          marginBottom: 16,
          fontSize: 12,
          color: '#0369A1',
          lineHeight: 1.5,
        }}>
          Controls what the AI can do when it receives inbound SMS messages.
          Actions start conservative and can be promoted after consecutive approvals.
        </div>

        {Object.entries(grouped).map(([actionType, actionConfigs]) => (
          <div key={actionType} style={{ marginBottom: 20 }}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              color: '#0F1724',
              textTransform: 'uppercase',
              letterSpacing: 1,
              marginBottom: 10,
              paddingBottom: 6,
              borderBottom: '1px solid rgba(0,0,0,0.06)',
            }}>
              {ACTION_LABELS[actionType] || actionType}
            </div>

            {actionConfigs.map(config => (
              <AutonomyRow
                key={config.id}
                config={config}
                onLevelChange={handleLevelChange}
                onResetCounters={handleResetCounters}
                isSaving={saving === config.id}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function AutonomyRow({ config, onLevelChange, onResetCounters, isSaving }) {
  const maxLevelOrder = { L1: 1, L2: 2, L3: 3, L4: 4 };
  const maxLevel = config.max_autonomy_level || 'L3';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 0',
      flexWrap: 'wrap',
    }}>
      {/* Entity type label */}
      <div style={{
        width: 80,
        fontSize: 13,
        fontWeight: 500,
        color: '#374151',
      }}>
        {ENTITY_LABELS[config.entity_type] || config.entity_type}
      </div>

      {/* Level selector */}
      <select
        value={config.autonomy_level}
        onChange={(e) => onLevelChange(config.id, e.target.value)}
        disabled={isSaving}
        style={{
          padding: '6px 12px',
          borderRadius: 8,
          border: '1px solid #E0E4EA',
          fontSize: 13,
          fontWeight: 500,
          color: '#0F1724',
          background: '#fff',
          cursor: 'pointer',
          minWidth: 160,
        }}
      >
        {LEVEL_OPTIONS.filter(opt =>
          maxLevelOrder[opt.value] <= maxLevelOrder[maxLevel]
        ).map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Max cap indicator */}
      <span style={{
        fontSize: 10,
        fontWeight: 600,
        color: '#7A8BA0',
        background: '#F3F4F6',
        padding: '3px 8px',
        borderRadius: 4,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}>
        Max: {maxLevel}
      </span>

      {/* Stats */}
      <div style={{
        display: 'flex',
        gap: 12,
        fontSize: 11,
        color: '#7A8BA0',
        marginLeft: 'auto',
        alignItems: 'center',
      }}>
        <span title="Consecutive approvals">
          {config.consecutive_approvals || 0} streak
        </span>
        <span title="Total approvals" style={{ color: '#10B981' }}>
          {config.total_approvals || 0} approved
        </span>
        <span title="Total rejections" style={{ color: '#EF4444' }}>
          {config.total_rejections || 0} rejected
        </span>
        {(config.total_approvals > 0 || config.total_rejections > 0) && (
          <button
            onClick={() => onResetCounters(config.id)}
            disabled={isSaving}
            style={{
              fontSize: 10,
              color: '#7A8BA0',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
