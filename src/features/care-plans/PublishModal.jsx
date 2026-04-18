import { useState } from 'react';
import { publishVersion } from './storage';
import btn from '../../styles/buttons.module.css';
import s from './PublishModal.module.css';

// ═══════════════════════════════════════════════════════════════
// PublishModal
//
// Confirms publication of a draft care plan version. Captures:
//   - Reason for this version (select + optional custom text)
//   - Agency signature (typed name, required)
//   - Client signature (typed name, optional)
//   - Client signature method (in-person / verbal / family / not collected)
//
// Published versions are immutable (enforced at the storage layer).
// If the admin later wants to change something, the panel will offer
// to start a new draft version — no silent edits.
// ═══════════════════════════════════════════════════════════════

const VERSION_REASONS = [
  'Initial intake',
  'Post-hospitalization update',
  'Quarterly review',
  'Condition change',
  'Family request',
  'Care team review',
  'Other',
];

const SIGNATURE_METHODS = [
  { key: 'in-person',     label: 'In person' },
  { key: 'verbal',        label: 'Verbal (phone / video)' },
  { key: 'family',        label: 'Family member on client\'s behalf' },
  { key: 'not-collected', label: 'Not collected' },
];

export function PublishModal({ version, currentUser, onClose, onPublished, showToast }) {
  const [reason, setReason] = useState(VERSION_REASONS[0]);
  const [otherReason, setOtherReason] = useState('');
  const defaultSig = currentUser?.displayName || currentUser?.email || '';
  const [agencySignedName, setAgencySignedName] = useState(defaultSig);
  const [clientSignedName, setClientSignedName] = useState('');
  const [clientSignedMethod, setClientSignedMethod] = useState('in-person');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState(null);

  const effectiveReason = reason === 'Other' ? otherReason.trim() : reason;
  const canSubmit = agencySignedName.trim().length > 0
    && effectiveReason.length > 0
    && !publishing;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setPublishing(true);
    setError(null);
    try {
      const userId = currentUser?.displayName || currentUser?.email || null;
      const updated = await publishVersion(version.id, {
        reason: effectiveReason,
        agencySignedName: agencySignedName.trim(),
        clientSignedName: clientSignedName.trim() || null,
        clientSignedMethod,
        userId,
      });
      showToast?.(`v${updated.versionNumber} published`);
      onPublished?.(updated);
      onClose?.();
    } catch (e) {
      console.error('[PublishModal] publish failed:', e);
      setError(e.message || 'Publish failed');
      setPublishing(false);
    }
  };

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div
        className={s.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Publish care plan version"
      >
        <header className={s.header}>
          <h2 className={s.title}>Publish v{version?.versionNumber ?? '?'}</h2>
          <button className={s.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className={s.body}>
          <p className={s.lede}>
            This version becomes immutable once published. If you need to
            change anything afterwards, a new draft will be created.
          </p>

          {error && <div className={s.errorBanner}>Publish failed: {error}</div>}

          <div className={s.field}>
            <label className={s.label}>
              Reason for this version
              <span className={s.required}>*</span>
            </label>
            <select
              className={s.input}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              {VERSION_REASONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            {reason === 'Other' && (
              <input
                type="text"
                className={`${s.input} ${s.otherInput}`}
                placeholder="Describe the reason..."
                value={otherReason}
                onChange={(e) => setOtherReason(e.target.value)}
              />
            )}
          </div>

          <div className={s.field}>
            <label className={s.label}>
              Agency signature (typed name)
              <span className={s.required}>*</span>
            </label>
            <input
              type="text"
              className={s.input}
              value={agencySignedName}
              onChange={(e) => setAgencySignedName(e.target.value)}
              placeholder="Your full name"
            />
            <p className={s.helpText}>
              You are certifying the plan on behalf of the agency. Your name
              and today's timestamp will be recorded.
            </p>
          </div>

          <div className={s.field}>
            <label className={s.label}>Client signature (typed name, optional)</label>
            <input
              type="text"
              className={s.input}
              value={clientSignedName}
              onChange={(e) => setClientSignedName(e.target.value)}
              placeholder="Client's full name (if collected)"
            />
          </div>

          <div className={s.field}>
            <label className={s.label}>How was the client signature obtained?</label>
            <div className={s.methodGrid}>
              {SIGNATURE_METHODS.map((m) => (
                <label key={m.key} className={s.methodOption}>
                  <input
                    type="radio"
                    name="sig-method"
                    checked={clientSignedMethod === m.key}
                    onChange={() => setClientSignedMethod(m.key)}
                  />
                  <span>{m.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <footer className={s.footer}>
          <button className={btn.secondaryBtn} onClick={onClose}>Cancel</button>
          <button
            className={btn.primaryBtn}
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {publishing ? 'Publishing…' : `Publish v${version?.versionNumber ?? '?'}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
