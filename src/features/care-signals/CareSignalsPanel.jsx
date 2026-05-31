import { useState, useEffect, useCallback } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  ClipboardCopy,
  ListPlus,
  Stethoscope,
} from 'lucide-react';
import {
  fetchOpenSignals,
  dispositionSignal,
  createFollowUpFromSignal,
} from './careSignalsActions';
import {
  sortSignals,
  severityMeta,
  categoryLabel,
  sbarToText,
  describeEvidence,
} from './careSignalHelpers';

const SEVERITY_ICONS = { AlertOctagon, AlertTriangle, Info };

function SeverityChip({ severity }) {
  const meta = severityMeta(severity);
  const Icon = SEVERITY_ICONS[meta.icon] || Info;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        background: meta.bg,
        color: meta.color,
        border: `1px solid ${meta.border}`,
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.3,
      }}
    >
      <Icon size={13} />
      {meta.label}
    </span>
  );
}

function Tag({ children }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 6,
        background: '#f1f5f9',
        color: '#475569',
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      {children}
    </span>
  );
}

function actionButtonStyle(variant) {
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 12px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid transparent',
  };
  if (variant === 'primary') return { ...base, background: '#1e293b', color: '#fff' };
  if (variant === 'danger') return { ...base, background: '#fff', color: '#dc2626', borderColor: '#fca5a5' };
  return { ...base, background: '#fff', color: '#334155', borderColor: '#cbd5e1' };
}

function SignalCard({ signal, clientName, currentUser, onResolved }) {
  const meta = severityMeta(signal.severity);
  const [expanded, setExpanded] = useState(signal.severity === 'urgent');
  const [busy, setBusy] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissReason, setDismissReason] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onResolved(signal.id);
    } catch (err) {
      console.error('[CareSignalsPanel] action failed', err);
      setError(err.message || 'Action failed');
      setBusy(false);
    }
  };

  const handleAcknowledge = () =>
    run(() => dispositionSignal(signal, { status: 'acknowledged', currentUser }));

  const handleDismiss = () => {
    if (!dismissReason.trim()) {
      setError('A reason is required to dismiss.');
      return;
    }
    return run(() =>
      dispositionSignal(signal, { status: 'dismissed', note: dismissReason.trim(), currentUser }),
    );
  };

  const handleCreateTask = () =>
    run(() => createFollowUpFromSignal(signal, { clientName, currentUser }));

  const handleCopySbar = async () => {
    try {
      await navigator.clipboard.writeText(sbarToText(signal.sbar, { clientName }));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to clipboard.');
    }
  };

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 12,
        border: `1px solid ${meta.border}`,
        overflow: 'hidden',
      }}
    >
      <div style={{ borderLeft: `4px solid ${meta.color}`, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <SeverityChip severity={signal.severity} />
              <span style={{ fontSize: 12, color: '#94a3b8' }}>
                {signal.createdAt ? new Date(signal.createdAt).toLocaleString() : ''}
              </span>
            </div>
            <p style={{ margin: '4px 0 8px', fontSize: 15, fontWeight: 600, color: '#1e293b' }}>
              {signal.summary}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {signal.categories.map((c) => (
                <Tag key={c}>{categoryLabel(c)}</Tag>
              ))}
            </div>
          </div>
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: 4 }}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          </button>
        </div>

        {expanded && (
          <div style={{ marginTop: 14 }}>
            {/* Evidence */}
            {signal.evidence.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Evidence
                </p>
                <ul style={{ margin: 0, paddingLeft: 18, color: '#475569', fontSize: 13, lineHeight: 1.6 }}>
                  {signal.evidence.map((ev, i) => (
                    <li key={ev.observation_id || i}>
                      {describeEvidence(ev)}
                      {ev.logged_at && (
                        <span style={{ color: '#94a3b8' }}> ({new Date(ev.logged_at).toLocaleString()})</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* SBAR draft */}
            {signal.sbar && (
              <div style={{ marginBottom: 14, background: '#f8fafc', borderRadius: 10, padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    <Stethoscope size={14} /> SBAR draft (for nurse review)
                  </span>
                  <button onClick={handleCopySbar} style={{ ...actionButtonStyle('secondary'), padding: '4px 9px' }}>
                    <ClipboardCopy size={13} /> {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <dl style={{ margin: 0, fontSize: 13, color: '#334155', lineHeight: 1.5 }}>
                  {['situation', 'background', 'assessment', 'recommendation'].map((k) =>
                    signal.sbar[k] ? (
                      <div key={k} style={{ marginBottom: 4 }}>
                        <dt style={{ display: 'inline', fontWeight: 700, textTransform: 'capitalize' }}>{k}: </dt>
                        <dd style={{ display: 'inline', margin: 0 }}>{signal.sbar[k]}</dd>
                      </div>
                    ) : null,
                  )}
                </dl>
              </div>
            )}

            <p style={{ margin: '0 0 12px', fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>
              AI-generated decision support for staff review — not a diagnosis.
            </p>

            {error && <p style={{ color: '#dc2626', fontSize: 13, margin: '0 0 10px' }}>{error}</p>}

            {/* Actions */}
            {dismissing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <textarea
                  value={dismissReason}
                  onChange={(e) => setDismissReason(e.target.value)}
                  placeholder="Why is this not a concern? (required)"
                  rows={2}
                  style={{ width: '100%', borderRadius: 8, border: '1px solid #cbd5e1', padding: 8, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={handleDismiss} disabled={busy} style={actionButtonStyle('danger')}>
                    <X size={14} /> Confirm dismiss
                  </button>
                  <button onClick={() => { setDismissing(false); setError(null); }} disabled={busy} style={actionButtonStyle('secondary')}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button onClick={handleCreateTask} disabled={busy} style={actionButtonStyle('primary')}>
                  <ListPlus size={14} /> Create follow-up task
                </button>
                <button onClick={handleAcknowledge} disabled={busy} style={actionButtonStyle('secondary')}>
                  <Check size={14} /> Acknowledge
                </button>
                <button onClick={() => setDismissing(true)} disabled={busy} style={actionButtonStyle('danger')}>
                  <X size={14} /> Dismiss
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function CareSignalsPanel({ client, currentUser }) {
  const clientId = client?.id;
  const clientName = [client?.firstName, client?.lastName].filter(Boolean).join(' ') || null;
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    try {
      const open = await fetchOpenSignals(clientId);
      setSignals(sortSignals(open));
    } catch (err) {
      // Table may not exist yet pre-deploy, or RLS denies — fail silent
      // so the panel simply hides rather than erroring the client page.
      console.warn('[CareSignalsPanel] load failed', err);
      setSignals([]);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleResolved = (id) => setSignals((prev) => prev.filter((s) => s.id !== id));

  // Nothing to show: render nothing (keeps the page clean when all-clear).
  if (loading || signals.length === 0) return null;

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 16,
        border: '1px solid #fed7aa',
        padding: 20,
        marginBottom: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <AlertTriangle size={18} color="#d97706" />
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1e293b' }}>Care Signals</h3>
        <span style={{ fontSize: 13, color: '#94a3b8' }}>
          {signals.length} need{signals.length === 1 ? 's' : ''} review
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
        Possible changes in condition detected from recent shift observations. Review and triage.
      </p>
      {signals.map((s) => (
        <SignalCard
          key={s.id}
          signal={s}
          clientName={clientName}
          currentUser={currentUser}
          onResolved={handleResolved}
        />
      ))}
    </div>
  );
}

export default CareSignalsPanel;
