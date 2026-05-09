// Phase 0.5 PR A — read-only manifest detail view.
//
// Shows every editable field in display-only form. PR B converts each
// field into an editable surface via per-field [Edit] modals. Until
// then, edits happen via the Supabase Dashboard if needed.
//
// Triggers field stays read-only forever (locked spec §2): cron
// schedules + invocation modes are tightly coupled to deployed cron
// entries; mutating from the UI without redeploying causes drift.

import { AgentVersionHistory } from './AgentVersionHistory';

export function AgentManifestEditor({ agent }) {
  if (!agent) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Field label="Display name" value={agent.name} />
      <Field label="Slug (read-only)" value={agent.slug} mono />
      <Field label="Model" value={agent.model} mono />
      <Field label="Max iterations" value={String(agent.max_iterations)} />

      <Block label="System prompt">
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: '#FFFFFF',
            border: '1px solid #E5E7EB',
            borderRadius: 6,
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 240,
            overflow: 'auto',
          }}
        >
          {agent.system_prompt || '(empty)'}
        </pre>
      </Block>

      <Block
        label={`Tool allowlist (${(agent.tool_allowlist || []).length})`}
      >
        {(agent.tool_allowlist || []).length === 0 ? (
          <div style={{ color: '#6B7280', fontSize: 13 }}>(none)</div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 6,
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {agent.tool_allowlist.map(tool => (
              <span key={tool} style={{ color: '#374151' }}>
                ✓ {tool}
              </span>
            ))}
          </div>
        )}
      </Block>

      <Block label="Autonomy profile">
        <JsonView value={agent.autonomy_profile} />
      </Block>

      <Block label="Context recipe">
        <JsonView value={agent.context_recipe} />
      </Block>

      <Block label="Triggers (read-only — coupled to deployed cron entries)">
        <JsonView value={agent.triggers} />
      </Block>

      <Block label="Outcome definition">
        <JsonView value={agent.outcome_definition} />
      </Block>

      <Block label="Version history">
        <AgentVersionHistory agentId={agent.id} currentVersion={agent.version} />
      </Block>

      <div
        style={{
          fontSize: 11,
          color: '#9CA3AF',
          paddingTop: 8,
          borderTop: '1px dashed #E5E7EB',
        }}
      >
        Created {fmtDate(agent.created_at)}
        {agent.created_by ? ` by ${agent.created_by}` : ''}
        {' · '}
        Last updated {fmtDate(agent.updated_at)}
        {agent.updated_by ? ` by ${agent.updated_by}` : ''}
      </div>

      <div style={{ fontSize: 12, color: '#6B7280' }}>
        Editing prompts, tool allowlist, and autonomy ships in PR B
        (Phase 0.5 part 2). Until then, kill switch and shadow mode
        toggles are immediate — other manifest changes go through the
        Supabase Dashboard.
      </div>
    </div>
  );
}

function Field({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: '#6B7280', minWidth: 140 }}>
        {label}:
      </span>
      <span
        style={{
          fontSize: 13,
          color: '#111827',
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
        }}
      >
        {value || <em style={{ color: '#9CA3AF' }}>(empty)</em>}
      </span>
    </div>
  );
}

function Block({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 500, color: '#6B7280', marginBottom: 6 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function JsonView({ value }) {
  let pretty;
  try {
    pretty = JSON.stringify(value ?? {}, null, 2);
  } catch {
    pretty = String(value);
  }
  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        background: '#FFFFFF',
        border: '1px solid #E5E7EB',
        borderRadius: 6,
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 200,
        overflow: 'auto',
      }}
    >
      {pretty}
    </pre>
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
