import { useState, useCallback } from 'react';
import { styles } from '../styles/theme';

function FormField({ label, field, type = 'text', required, placeholder, value, onChange }) {
  return (
    <div style={styles.field}>
      <label style={styles.fieldLabel}>
        {label} {required && <span style={{ color: '#DC3545' }}>*</span>}
      </label>
      <input
        style={styles.fieldInput}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(field, e.target.value)}
      />
    </div>
  );
}

export function AddCaregiver({ onAdd, onCancel }) {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    address: '',
    city: '',
    state: 'CA',
    zip: '',
    perId: '',
    hcaExpiration: '',
    source: 'Indeed',
    applicationDate: new Date().toISOString().split('T')[0],
    availability: '',
    hasHCA: 'yes',
    hasDL: 'yes',
    initialNotes: '',
  });

  const handleSubmit = () => {
    if (!form.firstName || !form.lastName) return;
    onAdd(form);
  };

  const handleFieldChange = useCallback((field, value) => {
    setForm((f) => ({ ...f, [field]: value }));
  }, []);

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={styles.pageTitle}>Add New Caregiver</h1>
          <p style={styles.pageSubtitle}>Enter candidate information to begin the onboarding pipeline</p>
        </div>
      </div>

      <div style={styles.formCard}>
        <h3 style={styles.formSection}>Personal Information</h3>
        <div style={styles.formGrid}>
          <FormField label="First Name" field="firstName" required placeholder="Jane" value={form.firstName} onChange={handleFieldChange} />
          <FormField label="Last Name" field="lastName" required placeholder="Doe" value={form.lastName} onChange={handleFieldChange} />
          <FormField label="Phone" field="phone" type="tel" placeholder="(949) 555-1234" value={form.phone} onChange={handleFieldChange} />
          <FormField label="Email" field="email" type="email" placeholder="jane@email.com" value={form.email} onChange={handleFieldChange} />
          <FormField label="Street Address" field="address" placeholder="123 Main St, Apt 4" value={form.address} onChange={handleFieldChange} />
          <FormField label="City" field="city" placeholder="Costa Mesa" value={form.city} onChange={handleFieldChange} />
          <FormField label="State" field="state" placeholder="CA" value={form.state} onChange={handleFieldChange} />
          <FormField label="Zip Code" field="zip" placeholder="92627" value={form.zip} onChange={handleFieldChange} />
        </div>

        <h3 style={styles.formSection}>Application Details</h3>
        <div style={styles.formGrid}>
          <FormField label="HCA PER ID" field="perId" placeholder="PER12345" value={form.perId} onChange={handleFieldChange} />
          <FormField label="HCA Expiration Date" field="hcaExpiration" type="date" value={form.hcaExpiration} onChange={handleFieldChange} />
          <div style={styles.field}>
            <label style={styles.fieldLabel}>Source</label>
            <select style={styles.fieldInput} value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}>
              <option>Indeed</option>
              <option>Website</option>
              <option>Referral</option>
              <option>Other</option>
            </select>
          </div>
          <FormField label="Application Date" field="applicationDate" type="date" value={form.applicationDate} onChange={handleFieldChange} />
          <FormField label="Availability" field="availability" placeholder="Mon-Fri, Days" value={form.availability} onChange={handleFieldChange} />
        </div>

        <div style={styles.formGrid}>
          <div style={styles.field}>
            <label style={styles.fieldLabel}>Has valid HCA ID?</label>
            <div style={styles.radioRow}>
              {['yes', 'no', 'willing'].map((v) => (
                <label key={v} style={styles.radioLabel}>
                  <input type="radio" name="hasHCA" checked={form.hasHCA === v} onChange={() => setForm((f) => ({ ...f, hasHCA: v }))} style={styles.radio} />
                  {v === 'willing' ? 'Willing to register' : v.charAt(0).toUpperCase() + v.slice(1)}
                </label>
              ))}
            </div>
          </div>
          <div style={styles.field}>
            <label style={styles.fieldLabel}>Has valid DL & Car?</label>
            <div style={styles.radioRow}>
              {['yes', 'no'].map((v) => (
                <label key={v} style={styles.radioLabel}>
                  <input type="radio" name="hasDL" checked={form.hasDL === v} onChange={() => setForm((f) => ({ ...f, hasDL: v }))} style={styles.radio} />
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </label>
              ))}
            </div>
          </div>
        </div>

        <h3 style={styles.formSection}>Notes</h3>
        <textarea
          style={styles.textarea}
          rows={3}
          placeholder="Initial notes about the candidate..."
          value={form.initialNotes}
          onChange={(e) => setForm((f) => ({ ...f, initialNotes: e.target.value }))}
        />

        <div style={styles.formActions}>
          <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={onCancel}>Cancel</button>
          <button className="tc-btn-primary" style={styles.primaryBtn} onClick={handleSubmit}>Add to Pipeline</button>
        </div>
      </div>
    </div>
  );
}
