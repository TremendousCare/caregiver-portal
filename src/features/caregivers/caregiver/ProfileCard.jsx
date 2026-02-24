import { useState } from 'react';
import { PHASES, EMPLOYMENT_STATUSES, AVAILABILITY_TYPES } from '../../../lib/constants';
import { getDaysSinceApplication } from '../../../lib/utils';
import cards from '../../../styles/cards.module.css';
import forms from '../../../styles/forms.module.css';
import btn from '../../../styles/buttons.module.css';
import { EditField } from './constants';

export function ProfileCard({ caregiver, onUpdateCaregiver }) {
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});

  const days = getDaysSinceApplication(caregiver);

  const startEditing = () => {
    setEditForm({
      firstName: caregiver.firstName || '', lastName: caregiver.lastName || '',
      phone: caregiver.phone || '', email: caregiver.email || '',
      address: caregiver.address || '', city: caregiver.city || '',
      state: caregiver.state || '', zip: caregiver.zip || '',
      perId: caregiver.perId || '', hcaExpiration: caregiver.hcaExpiration || '',
      hasHCA: caregiver.hasHCA || 'yes', hasDL: caregiver.hasDL || 'yes',
      availability: caregiver.availability || '', source: caregiver.source || '',
      sourceDetail: caregiver.sourceDetail || '',
      applicationDate: caregiver.applicationDate || '',
      yearsExperience: caregiver.yearsExperience || '',
      languages: caregiver.languages || '',
      specializations: caregiver.specializations || '',
      certifications: caregiver.certifications || '',
      preferredShift: caregiver.preferredShift || '',
      initialNotes: caregiver.initialNotes || '',
      employmentStatus: caregiver.employmentStatus || 'onboarding',
      availabilityType: caregiver.availabilityType || '',
      currentAssignment: caregiver.currentAssignment || '',
      cprExpiryDate: caregiver.cprExpiryDate || '',
    });
    setEditing(true);
  };

  const saveEdits = () => { onUpdateCaregiver(caregiver.id, editForm); setEditing(false); };
  const editField = (field, value) => { setEditForm((f) => ({ ...f, [field]: value })); };

  const profileFields = [
    { label: 'Full Name', value: `${caregiver.firstName} ${caregiver.lastName}` },
    { label: 'Phone', value: caregiver.phone },
    { label: 'Email', value: caregiver.email },
    { label: 'Address', value: (caregiver.address || caregiver.city) ? [caregiver.address, caregiver.city, caregiver.state, caregiver.zip].filter(Boolean).join(', ') : null },
    { label: 'HCA PER ID', value: caregiver.perId },
    { label: 'HCA Expiration Date', value: caregiver.hcaExpiration ? (() => { const exp = new Date(caregiver.hcaExpiration + 'T00:00:00'); const du = Math.ceil((exp - new Date()) / 86400000); const ds = exp.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); if (du < 0) return `⚠️ Expired — ${ds}`; if (du <= 30) return `⏰ ${ds} (${du} days)`; if (du <= 90) return `📅 ${ds} (${du} days)`; return `✅ ${ds}`; })() : null },
    { label: 'HCA Status', value: caregiver.hasHCA === 'yes' ? '✅ Valid HCA ID' : caregiver.hasHCA === 'willing' ? '📝 Willing to register' : '❌ No HCA ID' },
    { label: "Driver's License & Car", value: caregiver.hasDL === 'yes' ? '✅ Yes' : '❌ No' },
    { label: 'Availability', value: caregiver.availability },
    { label: 'Source', value: [caregiver.source, caregiver.sourceDetail].filter(Boolean).join(' — ') || null },
    { label: 'Application Date', value: caregiver.applicationDate ? new Date(caregiver.applicationDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null },
    { label: 'Days Since Application', value: `${days} day${days !== 1 ? 's' : ''}` },
    { label: 'Board Status', value: caregiver.boardStatus ? caregiver.boardStatus.charAt(0).toUpperCase() + caregiver.boardStatus.slice(1) : 'Not yet on board' },
    { label: 'Employment Status', value: (() => { const s = EMPLOYMENT_STATUSES.find((st) => st.id === caregiver.employmentStatus); return s ? s.label : 'Onboarding'; })() },
    { label: 'Availability Type', value: (() => { const t = AVAILABILITY_TYPES.find((ty) => ty.id === caregiver.availabilityType); return t ? t.label : null; })() },
    { label: 'Current Assignment', value: caregiver.currentAssignment || null },
    { label: 'CPR Expiry Date', value: caregiver.cprExpiryDate ? (() => { const exp = new Date(caregiver.cprExpiryDate + 'T00:00:00'); const du = Math.ceil((exp - new Date()) / 86400000); const ds = exp.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); if (du < 0) return `Expired — ${ds}`; if (du <= 90) return `${ds} (${du} days)`; return `${ds}`; })() : null },
    { label: 'Years of Experience', value: caregiver.yearsExperience ? ({ '0-1': 'Less than 1 year', '1-3': '1–3 years', '3-5': '3–5 years', '5-10': '5–10 years', '10+': '10+ years' }[caregiver.yearsExperience] || caregiver.yearsExperience) : null },
    { label: 'Preferred Shift', value: caregiver.preferredShift ? caregiver.preferredShift.charAt(0).toUpperCase() + caregiver.preferredShift.slice(1) : null },
    { label: 'Languages', value: caregiver.languages },
    { label: 'Specializations', value: caregiver.specializations },
    { label: 'Additional Certifications', value: caregiver.certifications },
    { label: 'Phase Override', value: caregiver.phaseOverride ? (() => { const p = PHASES.find((ph) => ph.id === caregiver.phaseOverride); return `⚙️ ${p?.icon} ${p?.label} (manual)`; })() : 'Auto (based on tasks)' },
  ];

  return (
    <div className={cards.profileCard}>
      <div className={cards.profileCardHeader}>
        <h3 className={cards.profileCardTitle}>👤 Profile Information</h3>
        {!editing ? (
          <button className={btn.editBtn} onClick={startEditing}>✏️ Edit</button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={btn.primaryBtn} onClick={saveEdits}>Save</button>
            <button className={btn.secondaryBtn} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        )}
      </div>

      {!editing ? (
        <>
          <div className={cards.profileGrid}>
            {profileFields.map((item) => (
              <div key={item.label} className={cards.profileItem}>
                <div className={cards.profileLabel}>{item.label}</div>
                <div className={cards.profileValue}>{item.value || '—'}</div>
              </div>
            ))}
          </div>
          {caregiver.initialNotes && (
            <div style={{ padding: '0 20px 16px' }}>
              <div className={cards.profileLabel}>Initial Notes</div>
              <div className={cards.profileValue} style={{ marginTop: 4 }}>{caregiver.initialNotes}</div>
            </div>
          )}
        </>
      ) : (
        <div style={{ padding: '16px 20px' }}>
          <div className={forms.formGrid}>
            <EditField label="First Name" value={editForm.firstName} onChange={(v) => editField('firstName', v)} />
            <EditField label="Last Name" value={editForm.lastName} onChange={(v) => editField('lastName', v)} />
            <EditField label="Phone" value={editForm.phone} onChange={(v) => editField('phone', v)} />
            <EditField label="Email" value={editForm.email} onChange={(v) => editField('email', v)} />
            <EditField label="Street Address" value={editForm.address} onChange={(v) => editField('address', v)} />
            <EditField label="City" value={editForm.city} onChange={(v) => editField('city', v)} />
            <EditField label="State" value={editForm.state} onChange={(v) => editField('state', v)} />
            <EditField label="Zip Code" value={editForm.zip} onChange={(v) => editField('zip', v)} />
            <EditField label="HCA PER ID" value={editForm.perId} onChange={(v) => editField('perId', v)} />
            <EditField label="HCA Expiration Date" value={editForm.hcaExpiration} onChange={(v) => editField('hcaExpiration', v)} type="date" />
            <div className={forms.field}>
              <label className={forms.fieldLabel}>HCA Status</label>
              <select className={forms.fieldInput} value={editForm.hasHCA} onChange={(e) => editField('hasHCA', e.target.value)}>
                <option value="yes">Valid HCA ID</option><option value="no">No HCA ID</option><option value="willing">Willing to register</option>
              </select>
            </div>
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Driver's License & Car</label>
              <select className={forms.fieldInput} value={editForm.hasDL} onChange={(e) => editField('hasDL', e.target.value)}>
                <option value="yes">Yes</option><option value="no">No</option>
              </select>
            </div>
            <EditField label="Availability" value={editForm.availability} onChange={(v) => editField('availability', v)} />
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Source</label>
              <select className={forms.fieldInput} value={editForm.source} onChange={(e) => editField('source', e.target.value)}>
                <option>Indeed</option><option>Website</option><option>Referral</option><option>Craigslist</option><option>Facebook</option><option>Job Fair</option><option>Walk-In</option><option>Agency Transfer</option><option>Other</option>
              </select>
            </div>
            <EditField label={editForm.source === 'Referral' ? 'Referred By' : 'Source Details'} value={editForm.sourceDetail} onChange={(v) => editField('sourceDetail', v)} />
            <EditField label="Application Date" value={editForm.applicationDate} onChange={(v) => editField('applicationDate', v)} type="date" />
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Employment Status</label>
              <select className={forms.fieldInput} value={editForm.employmentStatus} onChange={(e) => editField('employmentStatus', e.target.value)}>
                {EMPLOYMENT_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Availability Type</label>
              <select className={forms.fieldInput} value={editForm.availabilityType} onChange={(e) => editField('availabilityType', e.target.value)}>
                <option value="">Select...</option>
                {AVAILABILITY_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            <EditField label="Current Assignment" value={editForm.currentAssignment} onChange={(v) => editField('currentAssignment', v)} />
            <EditField label="CPR Expiry Date" value={editForm.cprExpiryDate} onChange={(v) => editField('cprExpiryDate', v)} type="date" />
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Years of Experience</label>
              <select className={forms.fieldInput} value={editForm.yearsExperience} onChange={(e) => editField('yearsExperience', e.target.value)}>
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
              <select className={forms.fieldInput} value={editForm.preferredShift} onChange={(e) => editField('preferredShift', e.target.value)}>
                <option value="">Select...</option>
                <option value="days">Days</option>
                <option value="evenings">Evenings</option>
                <option value="nights">Nights</option>
                <option value="weekends">Weekends</option>
                <option value="live-in">Live-In</option>
                <option value="flexible">Flexible / Any</option>
              </select>
            </div>
            <EditField label="Languages Spoken" value={editForm.languages} onChange={(v) => editField('languages', v)} />
            <EditField label="Specializations" value={editForm.specializations} onChange={(v) => editField('specializations', v)} />
            <EditField label="Additional Certifications" value={editForm.certifications} onChange={(v) => editField('certifications', v)} />
          </div>
          <div style={{ marginTop: 16 }}>
            <label className={forms.fieldLabel}>Initial Notes</label>
            <textarea className={forms.textarea} rows={3} value={editForm.initialNotes} onChange={(e) => editField('initialNotes', e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );
}
