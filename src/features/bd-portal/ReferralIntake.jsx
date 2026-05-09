import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBdAccounts } from './hooks/useBdAccounts';
import { useBdAccountDetail } from './hooks/useBdAccountDetail';
import { useBdLogReferral } from './hooks/useBdLogReferral';
import { validateReferralDraft } from './lib/bdMutations';
import { searchAccounts } from './lib/bdQueries';
import s from './BdPortal.module.css';

function nowLocalForInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function ReferralIntake() {
  const { accountId: lockedAccountId } = useParams();
  const navigate = useNavigate();
  const { accounts, loading: accountsLoading } = useBdAccounts();
  // When entering from /bd/accounts/:id/refer, fetch contacts for the
  // referring account so the user can attribute the lead to a specific
  // discharge planner / case manager.
  const { contacts: lockedContacts, account: lockedAccount } = useBdAccountDetail(lockedAccountId);
  const { submitting, submit } = useBdLogReferral();

  const [accountId, setAccountId]         = useState(lockedAccountId ?? '');
  const [accountSearch, setAccountSearch] = useState('');
  const [contactId, setContactId]         = useState('');
  const [name, setName]                   = useState('');
  const [phone, setPhone]                 = useState('');
  const [notes, setNotes]                 = useState('');
  const [referredAtLocal, setReferredAtLocal] = useState(nowLocalForInput);
  const [formError, setFormError]         = useState('');
  const [success, setSuccess]             = useState(null);

  // Keep contactId valid: clear it when the account changes.
  useEffect(() => { setContactId(''); }, [accountId]);

  const filteredOptions = useMemo(() => {
    if (lockedAccount) return [];
    return searchAccounts(accounts, accountSearch).slice(0, 8);
  }, [accounts, accountSearch, lockedAccount]);

  const selectedAccount = useMemo(() => {
    if (lockedAccount) return lockedAccount;
    return accounts.find((a) => a.id === accountId) ?? null;
  }, [accounts, accountId, lockedAccount]);

  // Contacts dropdown: the locked account's full contact list, or
  // empty (we don't fetch contacts for non-locked picks in this PR
  // to keep the form tight).
  const contactsForPicker = lockedAccountId ? lockedContacts : [];

  const selectedContact = useMemo(
    () => contactsForPicker.find((c) => c.id === contactId) ?? null,
    [contactsForPicker, contactId],
  );

  async function handleSubmit() {
    setFormError('');
    const draft = {
      account_id:        accountId,
      contact_id:        contactId || null,
      prospective_name:  name,
      prospective_phone: phone,
      prospective_notes: notes,
      referred_at:       new Date(referredAtLocal).toISOString(),
    };
    const validation = validateReferralDraft(draft);
    if (!validation.ok) {
      setFormError(validation.error);
      return;
    }
    try {
      const result = await submit({
        draft,
        accountName: selectedAccount?.name,
        contactName: selectedContact?.name,
      });
      setSuccess(result);
      setTimeout(() => {
        if (lockedAccountId) navigate(`/bd/accounts/${lockedAccountId}`);
        else navigate('/bd');
      }, 700);
    } catch (e) {
      setFormError(e?.message ?? 'Could not save. Try again.');
    }
  }

  if (success) {
    return (
      <div className={s.page}>
        <div className={s.card} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⭐</div>
          <p className={s.briefingText}>
            Referral logged. <strong>{success.client?.first_name} {success.client?.last_name}</strong> is now a new lead in the client pipeline.
          </p>
          <p className={s.muted} style={{ marginTop: 8 }}>Returning…</p>
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      <div className={s.detailHeader}>
        <button type="button" className={s.backBtn} onClick={() => navigate(-1)}>← Cancel</button>
        <h1 className={s.pageTitle} style={{ margin: 0 }}>Log referral</h1>
      </div>

      {formError && <div className={s.error}>{formError}</div>}

      {/* Referring account */}
      <div className={s.card}>
        <div className={s.sectionTitle}>Referring account</div>
        {lockedAccount ? (
          <div className={s.accountName}>{lockedAccount.name}</div>
        ) : accountsLoading ? (
          <p className={s.muted}>Loading your accounts…</p>
        ) : accountId && selectedAccount ? (
          <div className={s.contactRow}>
            <div className={s.accountName}>{selectedAccount.name}</div>
            <button
              type="button"
              className={s.linkBtn}
              onClick={() => { setAccountId(''); setAccountSearch(''); }}
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              className={s.input}
              type="search"
              placeholder="Search by name or city"
              value={accountSearch}
              onChange={(e) => setAccountSearch(e.target.value)}
              autoFocus
            />
            <div className={s.accountList} style={{ marginTop: 8 }}>
              {filteredOptions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={s.accountCard}
                  onClick={() => { setAccountId(a.id); setAccountSearch(''); }}
                >
                  <div className={s.accountName}>{a.name}</div>
                  <div className={s.accountMeta}>{a.city ?? '—'}</div>
                </button>
              ))}
              {accountSearch && filteredOptions.length === 0 && (
                <div className={s.empty}>No matches.</div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Contact (only when entering from a locked account) */}
      {lockedAccountId && contactsForPicker.length > 0 && (
        <div className={s.card}>
          <div className={s.sectionTitle}>Contact who referred (optional)</div>
          <select
            className={s.input}
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
          >
            <option value="">— None —</option>
            {contactsForPicker.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.role ? ` (${c.role.replaceAll('_', ' ')})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Prospective client */}
      <div className={s.card}>
        <div className={s.sectionTitle}>Prospective client</div>
        <input
          className={s.input}
          type="text"
          placeholder="Name (e.g. Mary Johnson)"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={s.input}
          type="tel"
          inputMode="tel"
          placeholder="Phone (optional)"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          style={{ marginTop: 8 }}
        />
      </div>

      {/* Notes */}
      <div className={s.card}>
        <div className={s.sectionTitle}>Notes (optional)</div>
        <textarea
          className={s.input}
          rows={4}
          placeholder="Discharge expected? Insurance? Family circumstances?"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ resize: 'vertical', minHeight: 96 }}
        />
      </div>

      {/* When */}
      <div className={s.card}>
        <div className={s.sectionTitle}>Referred at</div>
        <input
          className={s.input}
          type="datetime-local"
          value={referredAtLocal}
          onChange={(e) => setReferredAtLocal(e.target.value)}
        />
      </div>

      <button
        type="button"
        className={s.button}
        onClick={handleSubmit}
        disabled={submitting}
      >
        {submitting ? 'Saving referral…' : 'Save referral'}
      </button>
    </div>
  );
}
