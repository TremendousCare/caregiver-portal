import { useState, useCallback } from 'react';
import { CLIENT_SOURCES, CLIENT_PRIORITIES } from './constants';
import btn from '../../styles/buttons.module.css';
import forms from '../../styles/forms.module.css';
import layout from '../../styles/layout.module.css';

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

export function AddClient({ onAdd, onCancel }) {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    address: '',
    city: '',
    state: 'CA',
    zip: '',
    careRecipientName: '',
    careRecipientAge: '',
    relationship: '',
    careNeeds: '',
    hoursNeeded: '',
    startDatePreference: '',
    budgetRange: '',
    referralSource: 'Phone Call',
    referralDetail: '',
    priority: 'normal',
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
      <div className={layout.header}>
        <div>
          <h1 className={layout.pageTitle}>Add New Client</h1>
          <p className={layout.pageSubtitle}>Enter client information to begin the sales pipeline</p>
        </div>
      </div>

      <div className={forms.formCard}>
        <h3 className={forms.formSection}>Contact Information</h3>
        <div className={forms.formGrid}>
          <FormField label="First Name" field="firstName" required placeholder="John" value={form.firstName} onChange={handleFieldChange} />
          <FormField label="Last Name" field="lastName" required placeholder="Smith" value={form.lastName} onChange={handleFieldChange} />
          <FormField label="Phone" field="phone" type="tel" placeholder="(949) 555-1234" value={form.phone} onChange={handleFieldChange} />
          <FormField label="Email" field="email" type="email" placeholder="john@email.com" value={form.email} onChange={handleFieldChange} />
        </div>

        <h3 className={forms.formSection}>Address</h3>
        <div className={forms.formGrid}>
          <FormField label="Street Address" field="address" placeholder="123 Main St" value={form.address} onChange={handleFieldChange} />
          <FormField label="City" field="city" placeholder="Costa Mesa" value={form.city} onChange={handleFieldChange} />
          <FormField label="State" field="state" placeholder="CA" value={form.state} onChange={handleFieldChange} />
          <FormField label="Zip Code" field="zip" placeholder="92627" value={form.zip} onChange={handleFieldChange} />
        </div>

        <h3 className={forms.formSection}>Care Recipient</h3>
        <div className={forms.formGrid}>
          <FormField label="Care Recipient Name" field="careRecipientName" placeholder="Mary Smith" value={form.careRecipientName} onChange={handleFieldChange} />
          <FormField label="Care Recipient Age" field="careRecipientAge" type="number" placeholder="82" value={form.careRecipientAge} onChange={handleFieldChange} />
          <div className={forms.field}>
            <label className={forms.fieldLabel}>Relationship</label>
            <select className={forms.fieldInput} value={form.relationship} onChange={(e) => setForm((f) => ({ ...f, relationship: e.target.value }))}>
              <option value="">Select...</option>
              <option value="Self">Self</option>
              <option value="Spouse">Spouse</option>
              <option value="Parent">Parent</option>
              <option value="Child">Child</option>
              <option value="Sibling">Sibling</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </div>

        <h3 className={forms.formSection}>Care Needs</h3>
        <div className={forms.formGrid}>
          <div className={forms.field} style={{ gridColumn: '1 / -1' }}>
            <label className={forms.fieldLabel}>Care Needs Description</label>
            <textarea
              className={forms.textarea}
              rows={3}
              placeholder="Describe the care needs (e.g., daily assistance with bathing, medication reminders, light housekeeping...)"
              value={form.careNeeds}
              onChange={(e) => setForm((f) => ({ ...f, careNeeds: e.target.value }))}
            />
          </div>
          <FormField label="Hours Needed" field="hoursNeeded" placeholder="e.g., 4 hrs/day, Live-in, 20 hrs/week" value={form.hoursNeeded} onChange={handleFieldChange} />
          <div className={forms.field}>
            <label className={forms.fieldLabel}>Start Date Preference</label>
            <select className={forms.fieldInput} value={form.startDatePreference} onChange={(e) => setForm((f) => ({ ...f, startDatePreference: e.target.value }))}>
              <option value="">Select...</option>
              <option value="Immediate">Immediate</option>
              <option value="This Week">This Week</option>
              <option value="This Month">This Month</option>
              <option value="Flexible">Flexible</option>
            </select>
          </div>
          <FormField label="Budget Range" field="budgetRange" placeholder="e.g., $25-35/hr, $5000/mo" value={form.budgetRange} onChange={handleFieldChange} />
        </div>

        <h3 className={forms.formSection}>Lead Source</h3>
        <div className={forms.formGrid}>
          <div className={forms.field}>
            <label className={forms.fieldLabel}>Referral Source</label>
            <select className={forms.fieldInput} value={form.referralSource} onChange={(e) => setForm((f) => ({ ...f, referralSource: e.target.value }))}>
              {CLIENT_SOURCES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <FormField
            label={form.referralSource.includes('Referral') ? 'Referred By' : 'Source Details'}
            field="referralDetail"
            placeholder={form.referralSource.includes('Referral') ? 'Name of person/organization who referred' : 'Ad campaign, search term, etc.'}
            value={form.referralDetail}
            onChange={handleFieldChange}
          />
        </div>

        <h3 className={forms.formSection}>Priority</h3>
        <div className={forms.formGrid}>
          <div className={forms.field}>
            <label className={forms.fieldLabel}>Priority Level</label>
            <select className={forms.fieldInput} value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}>
              {CLIENT_PRIORITIES.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>

        <h3 className={forms.formSection}>Notes</h3>
        <textarea
          className={forms.textarea}
          rows={3}
          placeholder="Initial notes about this lead..."
          value={form.initialNotes}
          onChange={(e) => setForm((f) => ({ ...f, initialNotes: e.target.value }))}
        />

        <div className={forms.formActions}>
          <button className={`tc-btn-secondary ${btn.secondaryBtn}`} onClick={onCancel}>Cancel</button>
          <button className={`tc-btn-primary ${btn.primaryBtn}`} onClick={handleSubmit}>Add to Pipeline</button>
        </div>
      </div>
    </div>
  );
}
