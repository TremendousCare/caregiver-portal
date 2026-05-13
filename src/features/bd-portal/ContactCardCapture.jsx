import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Camera } from 'lucide-react';
import { useBdAccountDetail } from './hooks/useBdAccountDetail';
import { useBdExtractCard, useBdLogContact } from './hooks/useBdLogContact';
import {
  CONTACT_ROLES,
  CONTACT_ROLE_LABELS,
  validateContactDraft,
  normalizeContactRole,
} from './lib/bdMutations';
import s from './BdPortal.module.css';

// Capture flow:
//   1. Camera input → file selected
//   2. POST file to bd-extract-card → Claude Vision returns fields
//   3. Auto-fill form, rep edits anything that's wrong
//   4. Save → INSERT bd_account_contacts (with dedupe) → back to
//      account profile

export function ContactCardCapture() {
  const { accountId } = useParams();
  const navigate = useNavigate();
  const { account, loading: accountLoading } = useBdAccountDetail(accountId);
  const { extracting, extract } = useBdExtractCard();
  const { submitting, submit } = useBdLogContact();

  const fileInputRef = useRef(null);

  const [stage, setStage] = useState('start'); // start | review | success | duplicate
  const [formError, setFormError] = useState('');
  const [extractError, setExtractError] = useState('');

  // Form fields (pre-filled from extraction).
  const [name, setName]               = useState('');
  const [title, setTitle]             = useState('');
  const [role, setRole]               = useState('');
  const [email, setEmail]             = useState('');
  const [phoneMobile, setPhoneMobile] = useState('');
  const [phoneOffice, setPhoneOffice] = useState('');
  const [isPrimary, setIsPrimary]     = useState(false);
  const [duplicateContact, setDuplicateContact] = useState(null);

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(e) {
    setExtractError('');
    setFormError('');
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    try {
      const c = await extract(file);
      // Pre-fill from extraction. Coerce role to a CHECK-domain value
      // even if Claude returned a label or unknown string.
      setName(c?.name ?? '');
      setTitle(c?.title ?? '');
      setRole(normalizeContactRole(c?.role) ?? '');
      setEmail(c?.email ?? '');
      setPhoneMobile(c?.phone_mobile ?? '');
      setPhoneOffice(c?.phone_office ?? '');
      setStage('review');
    } catch (err) {
      setExtractError(err?.message ?? 'Could not read the card.');
    }
  }

  function handleManualEntry() {
    setStage('review');
  }

  async function handleSave() {
    setFormError('');
    const draft = {
      account_id:   accountId,
      name,
      title,
      role: role || null,
      email,
      phone_mobile: phoneMobile,
      phone_office: phoneOffice,
      is_primary: isPrimary,
    };
    const validation = validateContactDraft(draft);
    if (!validation.ok) {
      setFormError(validation.error);
      return;
    }
    try {
      const result = await submit(draft);
      if (result.duplicate) {
        setDuplicateContact(result.data?.existing ?? null);
        setStage('duplicate');
        return;
      }
      setStage('success');
      setTimeout(() => navigate(`/bd/accounts/${accountId}`), 800);
    } catch (e) {
      setFormError(e?.message ?? 'Could not save. Try again.');
    }
  }

  if (stage === 'success') {
    return (
      <div className={s.page}>
        <div className={s.card} style={{ textAlign: 'center' }}>
          <div className={s.successIcon} aria-hidden>
            <CheckCircle2 size={48} strokeWidth={1.75} />
          </div>
          <p className={s.briefingText}>
            <strong>{name}</strong> added to {account?.name ?? 'this account'}.
          </p>
          <p className={s.muted} style={{ marginTop: 8 }}>Returning…</p>
        </div>
      </div>
    );
  }

  if (stage === 'duplicate') {
    return (
      <div className={s.page}>
        <div className={s.detailHeader}>
          <button type="button" className={s.backBtn} onClick={() => navigate(-1)}>← Back</button>
          <h1 className={s.pageTitle} style={{ margin: 0 }}>Already on file</h1>
        </div>
        <div className={s.card}>
          <p className={s.briefingText}>
            <strong>{duplicateContact?.name}</strong> is already a contact on{' '}
            {account?.name ?? 'this account'}. We didn&rsquo;t add a duplicate.
          </p>
          {duplicateContact?.role && (
            <p className={s.muted}>
              Role on file: {CONTACT_ROLE_LABELS[duplicateContact.role] ?? duplicateContact.role}
            </p>
          )}
          <button
            type="button"
            className={s.button}
            onClick={() => navigate(`/bd/accounts/${accountId}`)}
          >
            Back to account
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      <div className={s.detailHeader}>
        <button type="button" className={s.backBtn} onClick={() => navigate(-1)}>← Cancel</button>
        <h1 className={s.pageTitle} style={{ margin: 0 }}>Add contact</h1>
      </div>

      {accountLoading ? (
        <div className={s.empty}>Loading account…</div>
      ) : !account ? (
        <div className={s.error}>Account not found.</div>
      ) : (
        <div className={s.card}>
          <div className={s.sectionTitle}>Account</div>
          <div className={s.accountName}>{account.name}</div>
        </div>
      )}

      {stage === 'start' && (
        <>
          <div className={s.card}>
            <div className={s.sectionTitle}>Snap the card</div>
            <p className={s.briefingText}>
              Take a photo of the business card. We&rsquo;ll read the name, role, email, and phone for you — you can edit before saving.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className={s.button}
              onClick={pickFile}
              disabled={extracting}
            >
              {extracting ? (
                'Reading card…'
              ) : (
                <>
                  <Camera size={16} aria-hidden />
                  <span>Take photo</span>
                </>
              )}
            </button>
            <button
              type="button"
              className={s.referCta}
              style={{ marginTop: 8 }}
              onClick={handleManualEntry}
              disabled={extracting}
            >
              Skip — enter manually
            </button>
            {extractError && <div className={s.error} style={{ marginTop: 12 }}>{extractError}</div>}
          </div>
        </>
      )}

      {stage === 'review' && (
        <>
          {formError && <div className={s.error}>{formError}</div>}

          <div className={s.card}>
            <div className={s.sectionTitle}>Contact</div>

            <input
              className={s.input}
              type="text"
              placeholder="Full name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className={s.input}
              type="text"
              placeholder="Job title (e.g. RN, BSN)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ marginTop: 8 }}
            />
            <select
              className={s.input}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={{ marginTop: 8 }}
            >
              <option value="">— Pick a role —</option>
              {CONTACT_ROLES.map((r) => (
                <option key={r} value={r}>{CONTACT_ROLE_LABELS[r]}</option>
              ))}
            </select>
          </div>

          <div className={s.card}>
            <div className={s.sectionTitle}>Reach</div>
            <input
              className={s.input}
              type="email"
              placeholder="Email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className={s.input}
              type="tel"
              inputMode="tel"
              placeholder="Mobile phone"
              autoComplete="tel"
              value={phoneMobile}
              onChange={(e) => setPhoneMobile(e.target.value)}
              style={{ marginTop: 8 }}
            />
            <input
              className={s.input}
              type="tel"
              inputMode="tel"
              placeholder="Office phone"
              value={phoneOffice}
              onChange={(e) => setPhoneOffice(e.target.value)}
              style={{ marginTop: 8 }}
            />
          </div>

          <div className={s.card}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#1A2332' }}>
              <input
                type="checkbox"
                checked={isPrimary}
                onChange={(e) => setIsPrimary(e.target.checked)}
              />
              Primary contact for this account
            </label>
          </div>

          <button
            type="button"
            className={s.button}
            onClick={handleSave}
            disabled={submitting}
          >
            {submitting ? 'Saving…' : 'Save contact'}
          </button>
        </>
      )}
    </div>
  );
}
