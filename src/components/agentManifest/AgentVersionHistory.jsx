// Phase 0.5 PR B — version history with Diff + Revert.
//
// PR A shipped read-only. PR B adds:
//   - [Diff] button per row → opens a modal showing the diff against
//     the previous version (K-1) so admins can read the change in
//     isolation.
//   - [Revert] button per row → opens RevertConfirmationDialog. The
//     current version row's button is disabled (no-op revert).
//
// The list refreshes after a successful revert via the onRevert
// callback the parent supplies.

import { useState } from 'react';
import { useAgentVersions } from './useAgentVersions';
import { useRevertAgent } from './useRevertAgent';
import { ManifestDiffView } from './ManifestDiffView';
import { RevertConfirmationDialog } from './RevertConfirmationDialog';

export function AgentVersionHistory({ agentId, currentVersion, onRevert, showToast }) {
  const { versions, loading, error, refresh } = useAgentVersions(agentId);
  const [diffTarget, setDiffTarget]   = useState(null);     // version row to diff vs prev
  const [revertTarget, setRevertTarget] = useState(null);   // version row to revert to
  const { reverting, revert }         = useRevertAgent();

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
    return <div style={{ fontSize: 12, color: '#6B7280' }}>No version history yet.</div>;
  }

  const handleRevertConfirm = async (changeSummary) => {
    if (!revertTarget) return;
    const result = await revert({
      agentId,
      targetVersion: revertTarget.version,
      changeSummary,
    });
    if (result.success) {
      setRevertTarget(null);
      showToast?.(`Reverted to version ${revertTarget.version} (now version ${result.newVersion})`);
      await refresh();
      onRevert?.();
    } else {
      const code = result.error?.code || result.error?.message || 'unknown';
      showToast?.(`Revert failed: ${code}`);
    }
  };

  // Reconstruct a "row-shape" object from a version snapshot so the
  // diff renderer (which expects manifest-row-shape inputs) can work
  // against historical versions. The snapshot was stored as
  // `to_jsonb(agents) - 'created_at' - 'updated_at'` so it already has
  // the right keys minus those two.
  const snapshotToRow = (snap) => snap || {};

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
          gridTemplateColumns: '60px 180px 160px 1fr 160px',
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
        <span style={{ textAlign: 'right' }}>Actions</span>
      </div>
      {versions.map((v, idx) => {
        const isCurrent = v.version === currentVersion;
        const previous  = versions[idx + 1] || null; // versions are DESC, so next idx is older
        return (
          <div
            key={v.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '60px 180px 160px 1fr 160px',
              fontSize: 12,
              padding: '10px 12px',
              borderBottom: '1px solid #F3F4F6',
              alignItems: 'baseline',
              background: isCurrent ? '#EEF2FF' : '#FFFFFF',
            }}
          >
            <span style={{ fontWeight: 600, color: '#111827' }}>
              v{v.version}
              {isCurrent && (
                <span style={{ fontSize: 10, fontWeight: 500, color: '#4338CA', marginLeft: 6 }}>
                  (current)
                </span>
              )}
            </span>
            <span style={{ color: '#374151' }}>{fmtDate(v.changed_at)}</span>
            <span style={{ color: '#374151' }}>{v.changed_by || 'system'}</span>
            <span style={{ color: '#4B5563' }}>
              {v.change_summary || <em style={{ color: '#9CA3AF' }}>(no summary)</em>}
            </span>
            <span style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              {previous && (
                <button
                  type="button"
                  onClick={() => setDiffTarget(v)}
                  style={smallBtn}
                  title={`Show diff vs v${previous.version}`}
                >
                  Diff
                </button>
              )}
              {!isCurrent && (
                <button
                  type="button"
                  onClick={() => setRevertTarget(v)}
                  style={smallBtnDanger}
                  title={`Revert to v${v.version}`}
                >
                  Revert
                </button>
              )}
            </span>
          </div>
        );
      })}

      {/* Diff modal */}
      {diffTarget && (
        <DiffModal
          target={diffTarget}
          previous={versions[versions.findIndex(v => v.id === diffTarget.id) + 1] || null}
          onClose={() => setDiffTarget(null)}
        />
      )}

      {/* Revert modal */}
      {revertTarget && (
        <RevertConfirmationDialog
          current={{
            // Build a current-row stand-in from the v=current snapshot.
            // The dialog renders the diff against this, then onConfirm
            // calls the RPC which uses the actual live agents row under
            // a row lock.
            ...snapshotToRow(versions.find(v => v.version === currentVersion)?.snapshot),
            version: currentVersion,
          }}
          targetVersion={revertTarget}
          busy={reverting}
          onConfirm={handleRevertConfirm}
          onClose={() => setRevertTarget(null)}
        />
      )}
    </div>
  );
}

function DiffModal({ target, previous, onClose }) {
  const before = previous?.snapshot || {};
  const after  = target.snapshot || {};
  return (
    <div style={backdropStyle} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Diff for version ${target.version}`}
        onClick={(e) => e.stopPropagation()}
        style={modalStyle}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#111827' }}>
            v{previous?.version ?? '—'} → v{target.version}
          </h2>
          <button type="button" onClick={onClose} style={closeBtn} aria-label="Close">✕</button>
        </div>
        <div style={{ fontSize: 13, color: '#6B7280', marginBottom: 12 }}>
          Author: <strong>{target.changed_by || 'system'}</strong>
          {' · '}
          {fmtDate(target.changed_at)}
          {target.change_summary && (
            <>
              {' · '}
              <em>{target.change_summary}</em>
            </>
          )}
        </div>
        <div
          style={{
            border: '1px solid #E5E7EB',
            borderRadius: 6,
            background: '#F9FAFB',
            padding: 12,
            maxHeight: '70vh',
            overflowY: 'auto',
          }}
        >
          {previous ? (
            <ManifestDiffView current={before} proposed={after} />
          ) : (
            <div style={{ fontSize: 13, color: '#6B7280', fontStyle: 'italic' }}>
              No prior version to diff against.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

const smallBtn = {
  fontSize: 11,
  fontWeight: 500,
  padding: '4px 10px',
  borderRadius: 4,
  border: '1px solid #D1D5DB',
  background: '#FFFFFF',
  color: '#374151',
  cursor: 'pointer',
};

const smallBtnDanger = {
  ...smallBtn,
  border: '1px solid #FECDCA',
  background: '#FEF2F2',
  color: '#B42318',
};

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
