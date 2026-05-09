// Phase 0.5 PR B — React renderer for the diff structures from diff.js.
//
// Pure presentational component. Takes (current, proposed) → renders
// the locked diff styles per §4 / §9 D8:
//   - inline      → "before → after" on one line
//   - lines/json  → unified diff (red/green) for system_prompt + JSON
//   - allowlist   → two columns (added / removed)

import { diffManifest, fieldLabel } from './diff';

export function ManifestDiffView({ current, proposed }) {
  const entries = diffManifest(current, proposed);

  if (entries.length === 0) {
    return (
      <div style={{ color: '#6B7280', fontSize: 13, fontStyle: 'italic' }}>
        No changes.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {entries.map(entry => (
        <DiffEntry key={entry.field} entry={entry} />
      ))}
    </div>
  );
}

function DiffEntry({ entry }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
        {fieldLabel(entry.field)}
      </div>
      {entry.kind === 'inline'    && <InlineDiff entry={entry} />}
      {entry.kind === 'lines'     && <LinesDiff entry={entry} />}
      {entry.kind === 'json'      && <LinesDiff entry={entry} />}
      {entry.kind === 'allowlist' && <AllowlistDiff entry={entry} />}
    </div>
  );
}

function InlineDiff({ entry }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontFamily: monoFont,
        padding: 10,
        background: '#F9FAFB',
        border: '1px solid #E5E7EB',
        borderRadius: 6,
      }}
    >
      <span style={{ background: '#FEE4E2', color: '#B42318', padding: '0 4px' }}>
        {entry.before || '(empty)'}
      </span>
      <span style={{ color: '#6B7280', margin: '0 8px' }}>→</span>
      <span style={{ background: '#D1FAE5', color: '#065F46', padding: '0 4px' }}>
        {entry.after || '(empty)'}
      </span>
    </div>
  );
}

function LinesDiff({ entry }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontFamily: monoFont,
        background: '#FFFFFF',
        border: '1px solid #E5E7EB',
        borderRadius: 6,
        overflow: 'hidden',
        maxHeight: 360,
        overflowY: 'auto',
      }}
    >
      {entry.lines.map((line, idx) => (
        <div
          key={idx}
          style={{
            padding: '2px 12px',
            background:
              line.op === 'add' ? '#ECFDF5' :
              line.op === 'del' ? '#FEF2F2' :
              '#FFFFFF',
            color:
              line.op === 'add' ? '#065F46' :
              line.op === 'del' ? '#B42318' :
              '#374151',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <span style={{ color: '#9CA3AF', userSelect: 'none', display: 'inline-block', width: 14 }}>
            {line.op === 'add' ? '+' : line.op === 'del' ? '−' : ' '}
          </span>
          {line.text || ' '}
        </div>
      ))}
    </div>
  );
}

function AllowlistDiff({ entry }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <Column title="Removed" items={entry.removed} bg="#FEF2F2" fg="#B42318" sigil="−" />
      <Column title="Added"   items={entry.added}   bg="#ECFDF5" fg="#065F46" sigil="+" />
    </div>
  );
}

function Column({ title, items, bg, fg, sigil }) {
  return (
    <div
      style={{
        background: bg,
        border: '1px solid #E5E7EB',
        borderRadius: 6,
        padding: 10,
        minHeight: 60,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: fg, marginBottom: 6 }}>
        {title} ({items.length})
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: '#9CA3AF', fontStyle: 'italic' }}>(none)</div>
      ) : (
        items.map(t => (
          <div
            key={t}
            style={{
              fontSize: 12,
              fontFamily: monoFont,
              color: fg,
            }}
          >
            <span style={{ display: 'inline-block', width: 14 }}>{sigil}</span>
            {t}
          </div>
        ))
      )}
    </div>
  );
}

const monoFont = 'ui-monospace, SFMono-Regular, Menlo, monospace';
