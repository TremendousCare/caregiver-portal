import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { useBdAccountDetail } from './hooks/useBdAccountDetail';
import {
  useBdContact,
  useBdLogContact,
  useBdUpdateContact,
} from './hooks/useBdLogContact';
import {
  CONTACT_ROLES,
  CONTACT_ROLE_LABELS,
  validateContactDraft,
} from './lib/bdMutations';
import s from './BdPortal.module.css';

// Single screen handles two modes:
//   - Edit existing:  /bd/accounts/:accountId/contact/:contactId/edit
//   - Add manually:    /bd/accounts/:accountId/contact/new
//
// The form fields and validation are identical; only the persistence
// path differs (UPDATE vs INSERT) and the heading/CTA copy.

export function ContactEditor() {
  const { accountId, contactId } = useParams();
  const isEdit = Boolean(contactId);
  const navigate = useNavigate();

  const { account, loading: accountLoading } = useBdAccountDetail(accountId);

  const { contact, loading: contactLoading, error: contactError } = useBdContact(isEdit ? contactId : null);
  const { submit: createSubmit, submitting: creating } = useBdLogContact();
  const { submit: updateSubmit, submitting: updating } = useBdUpdateContact(contactId);

  // Form fields.
  const [name, setName]               = useState('');
  const [title, setTitle]             = useState('');
  const [role, setRole]               = useState('');
  const [email, setEmail]             = useState('');
  const [phoneMobile, setPhoneMobile] = useState('');
  const [phoneOffice, setPhoneOffice] = useState('');
  const [notes, setNotes]             = useState('');
  const [isPrimary, setIsPrimary]     = useState(false);

  const [formError, setFormError] = useState('');
  const [success, setSuccess]     = useState(null);

  // Pre-fill when editing.
  useEffect(() => {
    if (!isEdit || !contact) return;
    setName(contact.name ?? '');
    setTitle(contact.title ?? '');
    setRole(contact.role ?? '');
    setEmail(contact.email ?? '');
    setPhoneMobile(contact.phone_mobile ?? '');
    setPhoneOffice(contact.phone_office ?? '');
    setNotes(contact.notes ?? '');
    setIsPrimary(Boolean(contact.is_primary));
  }, [isEdit, contact]);

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
      notes,
      is_primary: isPrimary,
    };
    const validation = validateContactDraft(draft);
    if (!validation.ok) {
      setFormError(validation.error);
      return;
    }
    try {
      if (isEdit) {
        await updateSubmit(draft);
      } else {
        const result = await createSubmit(draft);
        if (result?.duplicate) {
          setFormError(`A contact named "${name.trim()}" already exists on this account.`);
          return;
        }
      }
      setSuccess(isEdit ? 'updated' : 'created');
      setTimeout(() => navigate(`/bd/accounts/${accountId}`), 600);
    } catch (e) {
      setFormError(e?.message ?? 'Could not save. Try again.');
    }
  }

  if (success) {
    return (
      <div className={s.page}>
        <div className={s.card} style={{ textAlign: 'center' }}>
          <div className={s.successIcon} aria-hidden>
            <CheckCircle2 size={48} strokeWidth={1.75} />
          </div>
          <p className={s.briefingText}>
            {success === 'updated' ? 'Contact updated.' : `${name.trim()} added to ${account?.name ?? 'this account'}.`}
          </p>
          <p className={s.muted} style={{ marginTop: 8 }}>Returning…</p>
        </div>
      </div>
    );
  }

  const submitting = creating || updating;

  return (
    <div className={s.page}>
      <div className={s.detailHeader}>
        <button type="button" className={s.backBtn} onClick={() => navigate(-1)}>← Cancel</button>
        <h1 className={s.pageTitle} style={{ margin: 0 }}>
          {isEdit ? 'Edit contact' : 'Add contact'}
        </h1>
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

      {isEdit && contactLoading && (
        <div className={s.empty}>Loading contact…</div>
      )}
      {isEdit && contactError && (
        <div className={s.error}>Couldn&rsquo;t load contact: {contactError.message}</div>
      )}

      {(!isEdit || (!contactLoading && contact)) && (
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
              autoFocus={!isEdit}
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
            <div className={s.sectionTitle}>Notes</div>
            <textarea
              className={s.input}
              rows={3}
              placeholder="Anything worth remembering — birthday, kid's name, what she likes."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              style={{ resize: 'vertical', minHeight: 72 }}
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
            {submitting ? 'Saving…' : (isEdit ? 'Save changes' : 'Save contact')}
          </button>
        </>
      )}
    </div>
  );
}
