// Phase 0.5 PR A — one row in the agent manifest list.
//
// Header line shows: name, version chip, status dot, kill/shadow
// toggles, expand chevron. Expanded body shows the read-only manifest
// detail view + version history accordion.

import { AgentManifestEditor } from './AgentManifestEditor';
import { agentStatus, summariseAgent } from './queries';

export function AgentManifestRow({
  agent,
  expanded,
  onToggleExpand,
  onToggleFlag,
  saving, // 'kill_switch' | 'shadow_mode' | null
}) {
  const status = agentStatus(agent);

  return (
    <div
      style={{
        border: '1px solid #E5E7EB',
        borderRadius: 8,
        background: '#FFFFFF',
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          cursor: 'pointer',
        }}
        onClick={onToggleExpand}
      >
        {/* Name + slug summary */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontWeight: 600, color: '#111827' }}>{agent.name}</span>
            <VersionChip version={agent.version} />
            <StatusDot status={status} />
          </div>
          <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
            {summariseAgent(agent)}
          </div>
        </div>

        {/* Toggle buttons. stopPropagation so clicking a toggle doesn't
            also toggle the expand state. */}
        <div
          style={{ display: 'flex', gap: 8 }}
          onClick={(e) => e.stopPropagation()}
        >
          <ToggleButton
            label="Kill"
            active={!!agent.kill_switch}
            saving={saving === 'kill_switch'}
            onClick={() => onToggleFlag('kill_switch', !agent.kill_switch)}
            danger
            title={agent.kill_switch
              ? 'Click to re-enable this agent'
              : 'Click to stop this agent (next invocation skipped)'}
          />
          <ToggleButton
            label="Shadow"
            active={!!agent.shadow_mode}
            saving={saving === 'shadow_mode'}
            onClick={() => onToggleFlag('shadow_mode', !agent.shadow_mode)}
            title={agent.shadow_mode
              ? 'Click to exit shadow mode (live execution)'
              : 'Click to put this agent in shadow mode (no side-effects)'}
          />
        </div>

        {/* Chevron */}
        <span
          style={{
            color: '#6B7280',
            fontSize: 18,
            marginLeft: 4,
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
          }}
          aria-hidden="true"
        >
          ▸
        </span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div
          style={{
            borderTop: '1px solid #E5E7EB',
            padding: '16px 20px',
            background: '#F9FAFB',
          }}
        >
          <AgentManifestEditor agent={agent} />
        </div>
      )}
    </div>
  );
}

function VersionChip({ version }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        background: '#EEF2FF',
        color: '#4338CA',
        padding: '2px 8px',
        borderRadius: 999,
      }}
    >
      v{version}
    </span>
  );
}

function StatusDot({ status }) {
  const colors = {
    live:    { bg: '#10B981', label: 'live' },
    dormant: { bg: '#9CA3AF', label: 'dormant (kill switch on)' },
    shadow:  { bg: '#F59E0B', label: 'shadow mode' },
    unknown: { bg: '#D1D5DB', label: 'unknown' },
  };
  const c = colors[status] || colors.unknown;
  return (
    <span
      title={c.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: '#374151',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: c.bg,
          display: 'inline-block',
        }}
      />
      {c.label.split(' ')[0]}
    </span>
  );
}

function ToggleButton({ label, active, saving, onClick, danger, title }) {
  const activeBg = danger ? '#FEE4E2' : '#FEF3C7';
  const activeFg = danger ? '#B42318' : '#92400E';
  const activeBorder = danger ? '#FECDCA' : '#FDE68A';
  return (
    <button
      type="button"
      title={title}
      disabled={!!saving}
      onClick={onClick}
      style={{
        fontSize: 12,
        fontWeight: 500,
        padding: '6px 12px',
        borderRadius: 6,
        border: `1px solid ${active ? activeBorder : '#D1D5DB'}`,
        background: active ? activeBg : '#FFFFFF',
        color: active ? activeFg : '#374151',
        cursor: saving ? 'wait' : 'pointer',
        opacity: saving ? 0.7 : 1,
      }}
    >
      {saving ? '…' : `${label}: ${active ? 'on' : 'off'}`}
    </button>
  );
}
