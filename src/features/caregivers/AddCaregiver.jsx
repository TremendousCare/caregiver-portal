import { useState, useCallback, useMemo } from 'react';
import btn from '../../styles/buttons.module.css';
import forms from '../../styles/forms.module.css';
import layout from '../../styles/layout.module.css';
import { findDuplicateCaregiver } from '../../lib/utils';

function FormField({ label, field, type = 'text', required, placeholder, value, onChange }) {
  return (
    <div className={forms.field}>
      <label className={forms.fieldLabel}>
        {label} {required && <span style={{ color: '#DC3545' }}>*</span>}
      </label>
      <input
        className={forms.fieldInput}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(field, e.target.value)}
      />
    </div>
  );
}

export function AddCaregiver({ onAdd, onCancel, caregivers = [] }) {
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
    sourceDetail: '',
    applicationDate: new Date().toISOString().split('T')[0],
    availability: '',
    hasHCA: '',
    hasDL: '',
    hasVehicle: '',
    yearsExperience: '',
    languages: '',
    specializations: '',
    certifications: '',
    preferredShift: '',
    allergies: '',
    clientGenderPreference: '',
    initialNotes: '',
  });

  const [overrideDuplicate, setOverrideDuplicate] = useState(false);

  const duplicate = useMemo(
    () => findDuplicateCaregiver(
      { firstName: form.firstName, lastName: form.lastName, phone: form.phone },
      caregivers
    ),
    [form.firstName, form.lastName, form.phone, caregivers]
  );

  const handleSubmit = () => {
    if (!form.firstName || !form.lastName) return;
    if (duplicate && !overrideDuplicate) {
      setOverrideDuplicate(true);
      return;
    }
    onAdd(form);
  };

  const handleFieldChange = useCallback((field, value) => {
    setForm((f) => ({ ...f, [field]: value }));
    setOverrideDuplicate(false);
  }, []);

  return (
    <div>
      <div className={layout.header}>
        <div>
          <h1 className={layout.pageTitle}>Add New Caregiver</h1>
          <p className={layout.pageSubtitle}>Enter candidate information to begin the onboarding pipeline</p>
        </div>
      </div>

      <div className={forms.formCard}>
        <h3 className={forms.formSection}>Personal Information</h3>
        <div className={forms.formGrid}>
          <FormField label="First Name" field="firstName" required placeholder="Jane" value={form.firstName} onChange={handleFieldChange} />
          <FormField label="Last Name" field="lastName" required placeholder="Doe" value={form.lastName} onChange={handleFieldChange} />
          <FormField label="Phone" field="phone" type="tel" placeholder="(949) 555-1234" value={form.phone} onChange={handleFieldChange} />
          <FormField label="Email" field="email" type="email" placeholder="jane@email.com" value={form.email} onChange={handleFieldChange} />
          <FormField label="Street Address" field="address" placeholder="123 Main St, Apt 4" value={form.address} onChange={handleFieldChange} />
          <FormField label="City" field="city" placeholder="Costa Mesa" value={form.city} onChange={handleFieldChange} />
          <FormField label="State" field="state" placeholder="CA" value={form.state} onChange={handleFieldChange} />
          <FormField label="Zip Code" field="zip" placeholder="92627" value={form.zip} onChange={handleFieldChange} />
        </div>

        <h3 className={forms.formSection}>Application Details</h3>
        <div className={forms.formGrid}>
          <FormField label="HCA PER ID" field="perId" placeholder="PER12345" value={form.perId} onChange={handleFieldChange} />
          <FormField label="HCA Expiration Date" field="hcaExpiration" type="date" value={form.hcaExpiration} onChange={handleFieldChange} />
          <div className={forms.field}>
            <label className={forms.fieldLabel}>Source</label>
            <select className={forms.fieldInput} value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}>
              <option>Indeed</option>
              <option>Website</option>
              <option>Referral</option>
              <option>Craigslist</option>
              <option>Facebook</option>
              <option>Job Fair</option>
              <option>Walk-In</option>
              <option>Agency Transfer</option>
              <option>Other</option>
            </select>
          </div>
          <FormField
            label={form.source === 'Referral' ? 'Referred By' : 'Source Details'}
            field="sourceDetail"
            placeholder={form.source === 'Referral' ? 'Name of person who referred' : 'Job posting, campaign, etc.'}
            value={form.sourceDetail}
            onChange={handleFieldChange}
          />
          <FormField label="Application Date" field="applicationDate" type="date" value={form.applicationDate} onChange={handleFieldChange} />
          <FormField label="Availability" field="availability" placeholder="Mon-Fri, Days" value={form.availability} onChange={handleFieldChange} />
        </div>

        <div className={forms.formGrid}>
          <div className={forms.field}>
            <label className={forms.fieldLabel}>Has valid HCA ID?</label>
            <div className={forms.radioRow}>
              {['yes', 'no', 'willing'].map((v) => (
                <label key={v} className={forms.radioLabel}>
                  <input type="radio" name="hasHCA" checked={form.hasHCA === v} onChange={() => setForm((f) => ({ ...f, hasHCA: v }))} className={forms.radio} />
                  {v === 'willing' ? 'Willing to register' : v.charAt(0).toUpperCase() + v.slice(1)}
                </label>
              ))}
            </div>
          </div>
          <div className={forms.field}>
            <label className={forms.fieldLabel}>Has valid driver's license?</label>
            <div className={forms.radioRow}>
              {['yes', 'no'].map((v) => (
                <label key={v} className={forms.radioLabel}>
                  <input type="radio" name="hasDL" checked={form.hasDL === v} onChange={() => setForm((f) => ({ ...f, hasDL: v }))} className={forms.radio} />
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </label>
              ))}
            </div>
          </div>
          <div className={forms.field}>
            <label className={forms.fieldLabel}>Has own vehicle?</label>
            <div className={forms.radioRow}>
              {['yes', 'no'].map((v) => (
                <label key={v} className={forms.radioLabel}>
                  <input type="radio" name="hasVehicle" checked={form.hasVehicle === v} onChange={() => setForm((f) => ({ ...f, hasVehicle: v }))} className={forms.radio} />
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </label>
              ))}
            </div>
          </div>
        </div>

        <h3 className={forms.formSection}>Skills & Qualifications</h3>
        <div className={forms.formGrid}>
          <div className={forms.field}>
            <label className={forms.fieldLabel}>Years of Experience</label>
            <select className={forms.fieldInput} value={form.yearsExperience} onChange={(e) => setForm((f) => ({ ...f, yearsExperience: e.target.value }))}>
              <option value="">Select...</option>
              <option value="0-1">Less than 1 year</option>
              <option value="1-3">1–3 years</option>
              <option value="3-5">3–5 years</option>
              <option value="5-10">5–10 years</option>
              <option value="10+">10+ years</option>
            </select>
          </div>
          <div className={forms.field}>
            <label className={forms.fieldLabel}>Preferred Shift</label>
            <select className={forms.fieldInput} value={form.preferredShift} onChange={(e) => setForm((f) => ({ ...f, preferredShift: e.target.value }))}>
              <option value="">Select...</option>
              <option value="days">Days</option>
              <option value="evenings">Evenings</option>
              <option value="nights">Nights</option>
              <option value="weekends">Weekends</option>
              <option value="live-in">Live-In</option>
              <option value="flexible">Flexible / Any</option>
            </select>
          </div>
          <FormField label="Languages Spoken" field="languages" placeholder="English, Spanish, Tagalog..." value={form.languages} onChange={handleFieldChange} />
          <FormField label="Specializations" field="specializations" placeholder="Dementia, Hospice, Pediatric..." value={form.specializations} onChange={handleFieldChange} />
          <FormField label="Additional Certifications" field="certifications" placeholder="CNA, CPR, First Aid..." value={form.certifications} onChange={handleFieldChange} />
        </div>

        <h3 className={forms.formSection}>Preferences & Safety</h3>
        <div className={forms.formGrid}>
          <FormField label="Known Allergies" field="allergies" placeholder="Pets, smoke, latex..." value={form.allergies} onChange={handleFieldChange} />
          <div className={forms.field}>
            <label className={forms.fieldLabel}>Willing to work with</label>
            <select className={forms.fieldInput} value={form.clientGenderPreference} onChange={(e) => setForm((f) => ({ ...f, clientGenderPreference: e.target.value }))}>
              <option value="">Select...</option>
              <option value="both">Male and female clients</option>
              <option value="female">Female clients only</option>
              <option value="male">Male clients only</option>
            </select>
          </div>
        </div>

        <h3 className={forms.formSection}>Notes</h3>
        <textarea
          className={forms.textarea}
          rows={3}
          placeholder="Initial notes about the candidate..."
          value={form.initialNotes}
          onChange={(e) => setForm((f) => ({ ...f, initialNotes: e.target.value }))}
        />

        {duplicate && (
          <div style={{
            marginTop: 16,
            padding: '14px 18px',
            background: 'linear-gradient(135deg, #FFFBEB, #FEF3C7)',
            border: '1px solid #FDE68A',
            borderRadius: 10,
            color: '#92400E',
          }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
              ⚠️ Possible duplicate found
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              A caregiver named <strong>{duplicate.firstName} {duplicate.lastName}</strong>
              {duplicate.phone ? ` with phone ${duplicate.phone}` : ''} is already in the pipeline
              {duplicate.applicationDate ? ` (applied ${new Date(duplicate.applicationDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })})` : ''}.
              Check before adding again.
            </div>
            {overrideDuplicate && (
              <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600 }}>
                Click "Add Anyway" again to confirm you want to add this as a new record.
              </div>
            )}
          </div>
        )}

        <div className={forms.formActions}>
          <button className={`tc-btn-secondary ${btn.secondaryBtn}`} onClick={onCancel}>Cancel</button>
          <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={handleSubmit}>
            {duplicate ? (overrideDuplicate ? 'Add Anyway' : 'Review Duplicate') : 'Add to Pipeline'}
          </button>
        </div>
      </div>
    </div>
  );
}
