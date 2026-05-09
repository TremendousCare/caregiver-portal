// Phase 0.5 — top-level Settings UI for AI agent manifests.
//
// Slotted into AdminSettings between AutonomySettings and
// BusinessContextSettings. Lists every agent visible to the current
// org (RLS-scoped). Per locked §9 D9, expansion is in-page accordion
// rather than full-screen modal.
//
// PR A: read-only manifest detail + kill/shadow toggles.
// PR B: full editing + version-history diff + revert.

import { useState } from 'react';
import { CollapsibleCard } from '../../shared/components/CollapsibleCard';
import { useAgents } from './useAgents';
import { AgentManifestRow } from './AgentManifestRow';

export function AgentManifestSettings({ showToast }) {
  const { agents, loading, error, savingId, handleToggle, refresh } = useAgents();
  const [expandedId, setExpandedId] = useState(null);

  const onToggleExpand = (agentId) => {
    setExpandedId(prev => (prev === agentId ? null : agentId));
  };

  const onToggleFlag = async (agent, flag, nextValue) => {
    const result = await handleToggle(agent.id, flag, nextValue);
    if (result.success) {
      const verb = nextValue ? 'enabled' : 'disabled';
      const label = flag === 'kill_switch' ? 'Kill switch' : 'Shadow mode';
      showToast?.(`${label} ${verb} for ${agent.name}`);
    } else {
      const code = result.error?.code || result.error?.message || 'unknown';
      showToast?.(`Failed to update ${flag}: ${code}`);
    }
  };

  return (
    <CollapsibleCard
      title="AI Agents"
      description="Edit per-agent prompts, tool allowlists, kill switches, and version history."
    >
      <div style={{ padding: '16px 24px 24px', minHeight: 600 }}>
        {loading && (
          <div style={{ color: '#6B7280', padding: '8px 0' }}>Loading agents…</div>
        )}
        {error && !loading && (
          <div style={{ color: '#B42318', padding: '8px 0' }}>
            Failed to load agents: {error.message || String(error)}
          </div>
        )}
        {!loading && !error && agents.length === 0 && (
          <div style={{ color: '#6B7280', padding: '8px 0' }}>
            No agents found for this organization.
          </div>
        )}
        {!loading && !error && agents.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {agents.map(agent => (
              <AgentManifestRow
                key={agent.id}
                agent={agent}
                expanded={expandedId === agent.id}
                onToggleExpand={() => onToggleExpand(agent.id)}
                onToggleFlag={(flag, nextValue) => onToggleFlag(agent, flag, nextValue)}
                onSaved={refresh}
                showToast={showToast}
                saving={
                  savingId === `${agent.id}:kill_switch` ? 'kill_switch' :
                  savingId === `${agent.id}:shadow_mode` ? 'shadow_mode' :
                  null
                }
              />
            ))}
          </div>
        )}
      </div>
    </CollapsibleCard>
  );
}
