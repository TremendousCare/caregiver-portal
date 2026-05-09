// Phase 0.5 PR A — read-only version history accordion.
//
// Shows every row in `agent_versions` for one agent, newest first.
// PR B adds [Diff] and [Revert] action buttons; in PR A this is
// strictly a viewing surface.

import { useAgentVersions } from './useAgentVersions';

export function AgentVersionHistory({ agentId, currentVersion }) {
  const { versions, loading, error } = useAgentVersions(agentId);

  if (loading) {
    return <div style={{ fontSize: 12, color: '#6B7280' }}>Loading history…</div>;
  }
  if (error) {
    return (
      <div style={{ fontSize: 12, color: '#B42318' }}>
        Failed to load history: {error.message || String(error)}
      </div>
    );
  }
  if (versions.length === 0) {
    return (
      <div style={{ fontSize: 12, color: '#6B7280' }}>
        No version history yet.
      </div>
    );
  }

  return (
    <div
      style={{
        border: '1px solid #E5E7EB',
        borderRadius: 6,
        overflow: 'hidden',
        background: '#FFFFFF',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '60px 180px 160px 1fr',
          fontSize: 11,
          fontWeight: 600,
          color: '#6B7280',
          padding: '8px 12px',
          background: '#F9FAFB',
          borderBottom: '1px solid #E5E7EB',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        <span>Version</span>
        <span>Date</span>
        <span>Author</span>
        <span>Summary</span>
      </div>
      {versions.map(v => (
        <div
          key={v.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '60px 180px 160px 1fr',
            fontSize: 12,
            padding: '10px 12px',
            borderBottom: '1px solid #F3F4F6',
            alignItems: 'baseline',
            background: v.version === currentVersion ? '#EEF2FF' : '#FFFFFF',
          }}
        >
          <span style={{ fontWeight: 600, color: '#111827' }}>
            v{v.version}
            {v.version === currentVersion && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: '#4338CA',
                  marginLeft: 6,
                }}
              >
                (current)
              </span>
            )}
          </span>
          <span style={{ color: '#374151' }}>{fmtDate(v.changed_at)}</span>
          <span style={{ color: '#374151' }}>{v.changed_by || 'system'}</span>
          <span style={{ color: '#4B5563' }}>
            {v.change_summary || <em style={{ color: '#9CA3AF' }}>(no summary)</em>}
          </span>
        </div>
      ))}
    </div>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
