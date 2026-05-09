// Phase 0.5 PR B — save confirmation dialog.
//
// Triggered by the [Save…] button in AgentManifestEditor when the user
// has staged manifest changes. Shows the diff (current vs proposed)
// + a change_summary input + Save / Cancel actions.
//
// On save: calls onConfirm(changeSummary). The parent component handles
// the RPC call (via useUpdateAgent), conflict surfacing, and refresh.

import { useEffect, useState } from 'react';
import { ManifestDiffView } from './ManifestDiffView';
import { isManifestUnchanged } from './diff';

export function SaveConfirmationDialog({
  current,
  proposed,
  defaultSummary = '',
  busy,
  onConfirm,    // (changeSummary: string) => void
  onClose,
}) {
  const [summary, setSummary] = useState(defaultSummary);
  const unchanged = isManifestUnchanged(current, proposed);
  const summaryValid = summary.trim().length > 0;
  const canSave = !unchanged && summaryValid && !busy;

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) {
        e.preventDefault();
        onConfirm(summary.trim());
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  return (
    <div
      style={backdropStyle}
      onClick={busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm manifest save"
        onClick={(e) => e.stopPropagation()}
        style={modalStyle}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#111827' }}>
            Save changes to {current?.name || 'agent'}
          </h2>
          {!busy && (
            <button type="button" onClick={onClose} style={closeBtn} aria-label="Close">✕</button>
          )}
        </div>

        <div style={{ fontSize: 13, color: '#6B7280', marginBottom: 12 }}>
          This will create version <strong>{(current?.version || 1) + 1}</strong>. The
          previous version stays in the history and can be reverted to.
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
            placeholder="What changed? (e.g. tightened SMS reply tone)"
            disabled={busy}
            style={inputStyle}
            autoFocus
          />
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
            Required. Shown in the version history; future you will thank you.
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy} style={btnSecondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => onConfirm(summary.trim())}
            style={{
              ...btnPrimary,
              opacity: canSave ? 1 : 0.5,
              cursor: canSave ? 'pointer' : 'not-allowed',
            }}
            title="⌘/Ctrl + Enter"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
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

const btnPrimary = {
  padding: '8px 16px',
  borderRadius: 6,
  border: '1px solid #4338CA',
  background: '#4F46E5',
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
