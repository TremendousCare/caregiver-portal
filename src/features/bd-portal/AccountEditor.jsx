import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { useBdLogAccount } from './hooks/useBdLogAccount';
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  FACILITY_SUBTYPES,
  FACILITY_SUBTYPE_LABELS,
  PROFESSIONAL_SUBTYPES,
  PROFESSIONAL_SUBTYPE_LABELS,
  CONTACT_ROLES,
  CONTACT_ROLE_LABELS,
  validateAccountDraft,
} from './lib/bdMutations';
import s from './BdPortal.module.css';

// Single-screen create flow at /bd/accounts/new. Sections:
//   1) Basics        — name, type, subtype, strategic flag
//   2) Location & reach — address, city/state/zip, phone, website
//   3) Notes
//   4) Contacts (0..N, repeatable)
//
// On submit, runs server-side duplicate detection against the org's
// other accounts; if matches are found, shows a warning panel with
// links to the existing accounts and a "Create anyway" override.

function emptyContactDraft() {
  return {
    name:         '',
    title:        '',
    role:         '',
    email:        '',
    phone_mobile: '',
    phone_office: '',
    notes:        '',
    is_primary:   false,
  };
}

export function AccountEditor() {
  const navigate = useNavigate();
  const { submit, submitting } = useBdLogAccount();

  // Account fields.
  const [name, setName]                   = useState('');
  const [accountType, setAccountType]     = useState('facility');
  const [facilitySubtype, setFacilitySubtype]         = useState('');
  const [professionalSubtype, setProfessionalSubtype] = useState('');
  const [address, setAddress]   = useState('');
  const [city, setCity]         = useState('');
  const [stateAbbr, setStateAbbr] = useState('');
  const [zip, setZip]           = useState('');
  const [phone, setPhone]       = useState('');
  const [website, setWebsite]   = useState('');
  const [notes, setNotes]       = useState('');
  const [isStrategicShared, setIsStrategicShared] = useState(false);

  // Inline contacts.
  const [contacts, setContacts] = useState([emptyContactDraft()]);

  // Submit state.
  const [formError, setFormError] = useState('');
  const [duplicates, setDuplicates] = useState(null); // null | Array<{id,name,city,...}>
  const [success, setSuccess]     = useState(null);   // null | { account, contactCount }

  const buildDraft = () => ({
    name,
    account_type:         accountType,
    facility_subtype:     accountType === 'facility' ? facilitySubtype : null,
    professional_subtype: accountType === 'professional' ? professionalSubtype : null,
    address,
    city,
    state:                stateAbbr,
    zip,
    phone,
    website,
    notes,
    is_strategic_shared:  isStrategicShared,
  });

  // Contacts that actually have a name (others are blank rows the rep
  // didn't fill in — we skip them on save). Filter at submit time only;
  // keeping the empty row visible lets her add as she goes.
  const filledContacts = useMemo(
    () => contacts.filter((c) => c.name && c.name.trim()),
    [contacts],
  );

  function updateContact(idx, patch) {
    setContacts((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function setPrimaryContact(idx) {
    // Radio-style: only one row carries is_primary=true.
    setContacts((rows) => rows.map((r, i) => ({ ...r, is_primary: i === idx })));
  }

  function addContactRow() {
    setContacts((rows) => [...rows, emptyContactDraft()]);
  }

  function removeContactRow(idx) {
    setContacts((rows) => rows.filter((_, i) => i !== idx));
  }

  async function handleSave({ force } = { force: false }) {
    setFormError('');
    setDuplicates(null);
    const draft = buildDraft();
    const validation = validateAccountDraft(draft);
    if (!validation.ok) {
      setFormError(validation.error);
      return;
    }
    try {
      const result = await submit({ draft, contactDrafts: filledContacts, force });
      if (result?.duplicate) {
        setDuplicates(result.duplicates ?? []);
        return;
      }
      setSuccess({
        account: result.data,
        contactCount: result.contacts?.length ?? 0,
        contactErrors: result.contactErrors ?? [],
      });
      setTimeout(() => navigate(`/bd/accounts/${result.data.id}`), 700);
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
            {success.account?.name} added
            {success.contactCount > 0
              ? ` with ${success.contactCount} contact${success.contactCount === 1 ? '' : 's'}.`
              : '.'}
          </p>
          {success.contactErrors?.length > 0 && (
            <p className={s.muted} style={{ marginTop: 8, color: '#B83232' }}>
              {success.contactErrors.length} contact{success.contactErrors.length === 1 ? '' : 's'} couldn&rsquo;t be saved.
            </p>
          )}
          <p className={s.muted} style={{ marginTop: 8 }}>Opening account…</p>
        </div>
      </div>
    );
  }

  const subtypeOptions = accountType === 'facility'
    ? FACILITY_SUBTYPES.map((k) => [k, FACILITY_SUBTYPE_LABELS[k]])
    : PROFESSIONAL_SUBTYPES.map((k) => [k, PROFESSIONAL_SUBTYPE_LABELS[k]]);

  return (
    <div className={s.page}>
      <div className={s.detailHeader}>
        <button type="button" className={s.backBtn} onClick={() => navigate(-1)}>← Cancel</button>
        <h1 className={s.pageTitle} style={{ margin: 0 }}>Add account</h1>
      </div>

      {formError && <div className={s.error}>{formError}</div>}

      {duplicates && (
        <div className={s.card} style={{ borderColor: '#E0B33A', background: '#FFF8E6' }}>
          <div className={s.sectionTitle}>Possible duplicate{duplicates.length === 1 ? '' : 's'}</div>
          <p className={s.muted} style={{ marginTop: 0 }}>
            An account with this name already exists in your org. Open it to log activity there, or create anyway if this is a different location.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {duplicates.map((d) => (
              <button
                key={d.id}
                type="button"
                className={s.linkBtn}
                onClick={() => navigate(`/bd/accounts/${d.id}`)}
                style={{ justifyContent: 'flex-start' }}
              >
                <span>
                  {d.name}
                  {d.city ? ` · ${d.city}` : ''}
                </span>
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              type="button"
              className={s.button}
              style={{ background: '#B83232' }}
              onClick={() => handleSave({ force: true })}
              disabled={submitting}
            >
              {submitting ? 'Saving…' : 'Create anyway'}
            </button>
          </div>
        </div>
      )}

      <div className={s.card}>
        <div className={s.sectionTitle}>Basics</div>
        <input
          className={s.input}
          type="text"
          placeholder="Account name (e.g. Hoag Hospital — Newport Beach)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {ACCOUNT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={`${s.typeBtn} ${accountType === t ? s.typeBtnActive : ''}`}
              onClick={() => {
                setAccountType(t);
                // Clear the *other* axis so validation stays clean.
                if (t === 'facility') setProfessionalSubtype('');
                else setFacilitySubtype('');
              }}
              aria-pressed={accountType === t}
              style={{ flex: 1 }}
            >
              {ACCOUNT_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <select
          className={s.input}
          value={accountType === 'facility' ? facilitySubtype : professionalSubtype}
          onChange={(e) => {
            if (accountType === 'facility') setFacilitySubtype(e.target.value);
            else setProfessionalSubtype(e.target.value);
          }}
          style={{ marginTop: 8 }}
        >
          <option value="">— Pick a {accountType === 'facility' ? 'facility' : 'professional'} subtype —</option>
          {subtypeOptions.map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#1A2332', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={isStrategicShared}
            onChange={(e) => setIsStrategicShared(e.target.checked)}
          />
          Strategic — visible to all reps regardless of territory
        </label>
      </div>

      <div className={s.card}>
        <div className={s.sectionTitle}>Location &amp; reach</div>
        <input
          className={s.input}
          type="text"
          placeholder="Street address"
          autoComplete="street-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <div className={s.addressRow} style={{ marginTop: 8 }}>
          <input
            className={s.input}
            type="text"
            placeholder="City"
            autoComplete="address-level2"
            value={city}
            onChange={(e) => setCity(e.target.value)}
          />
          <input
            className={s.input}
            type="text"
            placeholder="State"
            autoComplete="address-level1"
            value={stateAbbr}
            onChange={(e) => setStateAbbr(e.target.value)}
            style={{ maxWidth: 80 }}
          />
          <input
            className={s.input}
            type="text"
            placeholder="ZIP"
            autoComplete="postal-code"
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            style={{ maxWidth: 100 }}
          />
        </div>
        <input
          className={s.input}
          type="tel"
          inputMode="tel"
          placeholder="Main phone"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          style={{ marginTop: 8 }}
        />
        <input
          className={s.input}
          type="url"
          inputMode="url"
          placeholder="Website (e.g. hoag.org)"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          style={{ marginTop: 8 }}
        />
      </div>

      <div className={s.card}>
        <div className={s.sectionTitle}>Notes</div>
        <textarea
          className={s.input}
          rows={3}
          placeholder="Hours, who to ask for, parking quirks, anything worth remembering."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ resize: 'vertical', minHeight: 72 }}
        />
      </div>

      <div className={s.card}>
        <div className={s.sectionTitle}>Contacts ({filledContacts.length})</div>
        <p className={s.muted} style={{ marginTop: 0 }}>
          Optional. Add people you&rsquo;ll work with at this account — you can add more later from the account profile.
        </p>
        {contacts.map((c, idx) => (
          <div
            key={idx}
            style={{
              borderTop: idx === 0 ? 'none' : '1px solid #E6E9EF',
              paddingTop: idx === 0 ? 0 : 12,
              marginTop: idx === 0 ? 8 : 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span className={s.muted}>Contact {idx + 1}</span>
              {contacts.length > 1 && (
                <button
                  type="button"
                  className={s.linkBtn}
                  onClick={() => removeContactRow(idx)}
                  aria-label="Remove this contact"
                  style={{ color: '#B83232', padding: '4px 8px' }}
                >
                  <Trash2 size={14} aria-hidden />
                  <span>Remove</span>
                </button>
              )}
            </div>
            <input
              className={s.input}
              type="text"
              placeholder="Full name"
              autoComplete="name"
              value={c.name}
              onChange={(e) => updateContact(idx, { name: e.target.value })}
            />
            <input
              className={s.input}
              type="text"
              placeholder="Job title (e.g. Director of Case Management)"
              value={c.title}
              onChange={(e) => updateContact(idx, { title: e.target.value })}
              style={{ marginTop: 8 }}
            />
            <select
              className={s.input}
              value={c.role}
              onChange={(e) => updateContact(idx, { role: e.target.value })}
              style={{ marginTop: 8 }}
            >
              <option value="">— Pick a role —</option>
              {CONTACT_ROLES.map((r) => (
                <option key={r} value={r}>{CONTACT_ROLE_LABELS[r]}</option>
              ))}
            </select>
            <input
              className={s.input}
              type="email"
              placeholder="Email"
              autoComplete="email"
              value={c.email}
              onChange={(e) => updateContact(idx, { email: e.target.value })}
              style={{ marginTop: 8 }}
            />
            <div className={s.addressRow} style={{ marginTop: 8 }}>
              <input
                className={s.input}
                type="tel"
                inputMode="tel"
                placeholder="Mobile"
                value={c.phone_mobile}
                onChange={(e) => updateContact(idx, { phone_mobile: e.target.value })}
              />
              <input
                className={s.input}
                type="tel"
                inputMode="tel"
                placeholder="Office"
                value={c.phone_office}
                onChange={(e) => updateContact(idx, { phone_office: e.target.value })}
              />
            </div>
            <textarea
              className={s.input}
              rows={2}
              placeholder="Notes — birthday, what she likes, who to ask for."
              value={c.notes}
              onChange={(e) => updateContact(idx, { notes: e.target.value })}
              style={{ resize: 'vertical', minHeight: 56, marginTop: 8 }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: '#1A2332', marginTop: 8 }}>
              <input
                type="radio"
                name="primaryContact"
                checked={Boolean(c.is_primary)}
                onChange={() => setPrimaryContact(idx)}
              />
              Primary contact for this account
            </label>
          </div>
        ))}
        <button
          type="button"
          className={s.linkBtn}
          onClick={addContactRow}
          style={{ marginTop: 12 }}
        >
          <Plus size={14} aria-hidden />
          <span>Add another contact</span>
        </button>
      </div>

      <button
        type="button"
        className={s.button}
        onClick={() => handleSave({ force: false })}
        disabled={submitting}
      >
        {submitting ? 'Saving…' : 'Save account'}
      </button>
    </div>
  );
}
