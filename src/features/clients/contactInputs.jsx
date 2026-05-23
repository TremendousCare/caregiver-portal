// Inputs for Emergency Contacts and Responsible Parties — used by
// AddClient.jsx today and by ClientDetail later (when we surface
// editing post-intake).
//
// State is "lifted" — these components are controlled. The parent
// (AddClient) owns the form state and just passes value + onChange.
// Output shape matches what src/lib/clientContacts.js expects.

import { useCallback } from 'react';
import { Trash2, Plus } from 'lucide-react';
import forms from '../../styles/forms.module.css';
import btn from '../../styles/buttons.module.css';

const CONTACT_FOR_OPTIONS = [
  'Care concerns',
  'Care decisions',
  'Billing',
  'Scheduling',
  'Other',
];

// ─── Emergency Contacts ──────────────────────────────────────

export function emptyEmergencyContact() {
  return { name: '', relationship: '', phone: '', altPhone: '', email: '', notes: '' };
}

export function EmergencyContactsSection({ value, onChange }) {
  const contacts = value && value.length > 0 ? value : [emptyEmergencyContact()];

  const update = useCallback((index, patch) => {
    const next = contacts.map((c, i) => (i === index ? { ...c, ...patch } : c));
    onChange(next);
  }, [contacts, onChange]);

  const addRow = useCallback(() => {
    onChange([...contacts, emptyEmergencyContact()]);
  }, [contacts, onChange]);

  const removeRow = useCallback((index) => {
    const next = contacts.filter((_, i) => i !== index);
    onChange(next.length === 0 ? [emptyEmergencyContact()] : next);
  }, [contacts, onChange]);

  return (
    <div>
      <h3 className={forms.formSection}>Emergency Contacts</h3>
      <p style={{ fontSize: 13, color: 'var(--tc-text-secondary)', marginTop: -8, marginBottom: 16 }}>
        Listed in call order. The first contact is the primary. Reorder by deleting and re-adding for now —
        full reordering controls land on the client detail page in a follow-up.
      </p>

      {contacts.map((c, idx) => (
        <ContactRow
          key={idx}
          index={idx}
          contact={c}
          onUpdate={(patch) => update(idx, patch)}
          onRemove={contacts.length > 1 ? () => removeRow(idx) : null}
        />
      ))}

      <button
        type="button"
        className={btn.secondaryBtn}
        onClick={addRow}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8 }}
      >
        <Plus size={14} /> Add another emergency contact
      </button>
    </div>
  );
}

function ContactRow({ index, contact, onUpdate, onRemove }) {
  const label =
    index === 0 ? 'Primary Emergency Contact' :
    index === 1 ? 'Secondary Emergency Contact' :
    `Additional Contact (#${index + 1})`;

  return (
    <div style={rowCardStyle}>
      <div style={rowHeaderStyle}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--tc-navy)' }}>{label}</span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${label}`}
            style={iconBtnStyle}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div className={forms.formGrid}>
        <Field label="Name" required value={contact.name} onChange={(v) => onUpdate({ name: v })} placeholder="Jane Smith" />
        <Field label="Relationship" value={contact.relationship} onChange={(v) => onUpdate({ relationship: v })} placeholder="Daughter, neighbor, friend..." />
        <Field label="Phone" required type="tel" value={contact.phone} onChange={(v) => onUpdate({ phone: v })} placeholder="(949) 555-1234" />
        <Field label="Alt phone" type="tel" value={contact.altPhone} onChange={(v) => onUpdate({ altPhone: v })} placeholder="(949) 555-5678" />
        <Field label="Email" type="email" value={contact.email} onChange={(v) => onUpdate({ email: v })} placeholder="jane@email.com" />
        <Field label="Notes" value={contact.notes} onChange={(v) => onUpdate({ notes: v })} placeholder="Best to call after 6pm..." />
      </div>
    </div>
  );
}

// ─── Responsible Parties ─────────────────────────────────────

export function emptyResponsibleParty() {
  return {
    name: '', relationship: '', phone: '', email: '',
    contactFor: [],
    hipaaOnFile: false, financialPoa: false, healthcarePoa: false,
    isMainPointOfContact: false,
    notes: '',
  };
}

export function emptyResponsiblePartySet() {
  return { primary: emptyResponsibleParty(), secondary: emptyResponsibleParty() };
}

export function ResponsiblePartiesSection({ value, onChange }) {
  const parties = value || emptyResponsiblePartySet();

  const updateParty = useCallback((rank, patch) => {
    let next = { ...parties, [rank]: { ...parties[rank], ...patch } };
    // Enforce single "main point of contact" across primary + secondary
    // so the partial UNIQUE index does not reject the insert. If the
    // user just flipped a flag on, clear it on the other.
    if (patch.isMainPointOfContact === true) {
      const otherRank = rank === 'primary' ? 'secondary' : 'primary';
      next = { ...next, [otherRank]: { ...next[otherRank], isMainPointOfContact: false } };
    }
    onChange(next);
  }, [parties, onChange]);

  return (
    <div>
      <h3 className={forms.formSection}>Responsible Party</h3>
      <p style={{ fontSize: 13, color: 'var(--tc-text-secondary)', marginTop: -8, marginBottom: 16 }}>
        Person(s) authorized to make decisions about care, billing, or scheduling. Different from emergency contacts.
      </p>

      <ResponsiblePartyRow
        label="Primary Responsible Party"
        value={parties.primary}
        onChange={(patch) => updateParty('primary', patch)}
      />

      <ResponsiblePartyRow
        label="Secondary Responsible Party (optional)"
        value={parties.secondary}
        onChange={(patch) => updateParty('secondary', patch)}
      />
    </div>
  );
}

function ResponsiblePartyRow({ label, value, onChange }) {
  const v = value || emptyResponsibleParty();

  const toggleContactFor = useCallback((option) => {
    const set = new Set(v.contactFor || []);
    if (set.has(option)) set.delete(option);
    else set.add(option);
    onChange({ contactFor: Array.from(set) });
  }, [v.contactFor, onChange]);

  return (
    <div style={rowCardStyle}>
      <div style={rowHeaderStyle}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--tc-navy)' }}>{label}</span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--tc-text-secondary)' }}>
          <input
            type="checkbox"
            checked={!!v.isMainPointOfContact}
            onChange={(e) => onChange({ isMainPointOfContact: e.target.checked })}
          />
          Main point of contact
        </label>
      </div>

      <div className={forms.formGrid}>
        <Field label="Name" value={v.name} onChange={(val) => onChange({ name: val })} placeholder="John Smith" />
        <Field label="Relationship" value={v.relationship} onChange={(val) => onChange({ relationship: val })} placeholder="Spouse, son, attorney..." />
        <Field label="Phone" type="tel" value={v.phone} onChange={(val) => onChange({ phone: val })} placeholder="(949) 555-1234" />
        <Field label="Email" type="email" value={v.email} onChange={(val) => onChange({ email: val })} placeholder="john@email.com" />
      </div>

      <div style={{ marginTop: 12 }}>
        <div className={forms.fieldLabel}>Contact for</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
          {CONTACT_FOR_OPTIONS.map((opt) => {
            const selected = (v.contactFor || []).includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggleContactFor(opt)}
                style={chipStyle(selected)}
              >
                {opt}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 14 }}>
        <CheckLabel
          checked={!!v.hipaaOnFile}
          onChange={(c) => onChange({ hipaaOnFile: c })}
          label="HIPAA release on file"
        />
        <CheckLabel
          checked={!!v.financialPoa}
          onChange={(c) => onChange({ financialPoa: c })}
          label="Financial POA"
        />
        <CheckLabel
          checked={!!v.healthcarePoa}
          onChange={(c) => onChange({ healthcarePoa: c })}
          label="Healthcare POA"
        />
      </div>
    </div>
  );
}

// ─── Small inputs ────────────────────────────────────────────

function Field({ label, required, type = 'text', value, onChange, placeholder }) {
  return (
    <div className={forms.field}>
      <label className={forms.fieldLabel}>
        {label} {required && <span style={{ color: '#DC3545' }}>*</span>}
      </label>
      <input
        className={forms.fieldInput}
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function CheckLabel({ checked, onChange, label }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--tc-text-secondary)' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ─── Inline styles ───────────────────────────────────────────
// Inline rather than a new CSS module because these styles are
// tightly bound to the layout above and only used here. Promote to
// a module if these components get reused outside intake.

const rowCardStyle = {
  border: '1px solid #E0E4EA',
  borderRadius: 12,
  padding: 16,
  marginBottom: 12,
  background: '#FAFBFC',
};

const rowHeaderStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
};

const iconBtnStyle = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: '#DC3545',
  padding: 4,
  borderRadius: 4,
  display: 'inline-flex',
};

function chipStyle(selected) {
  return {
    padding: '6px 12px',
    borderRadius: 999,
    border: selected ? '1px solid var(--tc-cyan)' : '1px solid #E0E4EA',
    background: selected ? 'rgba(41,190,228,0.12)' : '#fff',
    color: selected ? 'var(--tc-navy)' : 'var(--tc-text-secondary)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  };
}
