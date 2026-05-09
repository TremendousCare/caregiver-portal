// Phase 0.5 PR B — revert confirmation dialog.
//
// Triggered by the [Revert] button in AgentVersionHistory. Shows the
// diff between current state and the target snapshot + a
// change_summary input + Revert / Cancel.
//
// On confirm: calls onConfirm(changeSummary). The parent handles the
// RPC call (via useRevertAgent), refresh, and toast.

import { useEffect, useState } from 'react';
import { ManifestDiffView } from './ManifestDiffView';

export function RevertConfirmationDialog({
  current,
  targetVersion,        // { version, snapshot, changed_by, changed_at, change_summary }
  busy,
  onConfirm,            // (changeSummary: string) => void
  onClose,
}) {
  const defaultSummary = `Reverted to version ${targetVersion?.version ?? '?'}`;
  const [summary, setSummary] = useState(defaultSummary);

  // The "proposed" row for the diff is the target snapshot's editable
  // fields layered onto the current row. (Excluded fields stay at
  // their current values per locked §3.5.)
  const proposed = buildProposedFromSnapshot(current, targetVersion?.snapshot);

  const summaryValid = summary.trim().length > 0;
  const canRevert = !!targetVersion && summaryValid && !busy;

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canRevert) {
        e.preventDefault();
        onConfirm(summary.trim());
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  if (!targetVersion) return null;

  return (
    <div style={backdropStyle} onClick={busy ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm revert"
        onClick={(e) => e.stopPropagation()}
        style={modalStyle}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#111827' }}>
            Revert {current?.name || 'agent'} to version {targetVersion.version}
          </h2>
          {!busy && (
            <button type="button" onClick={onClose} style={closeBtn} aria-label="Close">✕</button>
          )}
        </div>

        <div style={{ fontSize: 13, color: '#6B7280', marginBottom: 12 }}>
          This will create version <strong>{(current?.version || 1) + 1}</strong> with the
          editable fields restored from version {targetVersion.version}. Identity
          fields (id, slug, org), operational levers (kill switch, shadow mode),
          and triggers stay at their current values. The historical row at
          v{targetVersion.version} is never modified.
        </div>

        <div
          style={{
            border: '1px solid #E5E7EB',
            borderRadius: 6,
            background: '#F9FAFB',
            padding: 12,
            marginBottom: 16,
            maxHeight: '50vh',
            overflowY: 'auto',
          }}
        >
          <ManifestDiffView current={current} proposed={proposed} />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, fontWeight: 500, color: '#374151', display: 'block', marginBottom: 6 }}>
            Change summary <span style={{ color: '#B42318' }}>*</span>
          </label>
          <input
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            disabled={busy}
            style={inputStyle}
            autoFocus
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy} style={btnSecondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!canRevert}
            onClick={() => onConfirm(summary.trim())}
            style={{
              ...btnDanger,
              opacity: canRevert ? 1 : 0.5,
              cursor: canRevert ? 'pointer' : 'not-allowed',
            }}
            title="⌘/Ctrl + Enter"
          >
            {busy ? 'Reverting…' : `Revert to v${targetVersion.version}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Build a "proposed" agent row by copying the target snapshot's
// editable fields onto the current row. Mirrors the RPC's logic: only
// editable fields change; identity / operational / triggers stay.
function buildProposedFromSnapshot(current, snapshot) {
  if (!current || !snapshot) return current;
  const editableFields = [
    'name', 'system_prompt', 'tool_allowlist', 'autonomy_profile',
    'context_recipe', 'model', 'max_iterations', 'outcome_definition',
  ];
  const out = { ...current };
  for (const f of editableFields) {
    if (f in snapshot) out[f] = snapshot[f];
  }
  return out;
}

const backdropStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(17, 24, 39, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const modalStyle = {
  background: '#FFFFFF',
  borderRadius: 8,
  padding: 24,
  width: 'min(820px, 94vw)',
  maxHeight: '92vh',
  overflow: 'auto',
  boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
};

const closeBtn = {
  background: 'transparent',
  border: 'none',
  fontSize: 22,
  cursor: 'pointer',
  color: '#6B7280',
  lineHeight: 1,
};

const inputStyle = {
  width: '100%',
  padding: '8px 12px',
  border: '1px solid #D1D5DB',
  borderRadius: 6,
  fontSize: 13,
  background: '#FFFFFF',
  color: '#111827',
  boxSizing: 'border-box',
};

const btnDanger = {
  padding: '8px 16px',
  borderRadius: 6,
  border: '1px solid #B42318',
  background: '#DC2626',
  color: '#FFFFFF',
  fontSize: 13,
  fontWeight: 500,
};

const btnSecondary = {
  padding: '8px 16px',
  borderRadius: 6,
  border: '1px solid #D1D5DB',
  background: '#FFFFFF',
  color: '#374151',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};
