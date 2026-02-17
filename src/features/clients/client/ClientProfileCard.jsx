import { useState } from 'react';
import { CLIENT_PHASES, CLIENT_SOURCES, CLIENT_PRIORITIES } from '../constants';
import { getClientPhase, getDaysSinceCreated } from '../utils';
import cards from '../../../styles/cards.module.css';
import forms from '../../../styles/forms.module.css';
import btn from '../../../styles/buttons.module.css';

function EditField({ label, value, onChange, type = 'text' }) {
  return (
    <div className={forms.field}>
      <label className={forms.fieldLabel}>{label}</label>
      <input className={forms.fieldInput} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function ClientProfileCard({ client, onUpdateClient }) {
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});

  const days = getDaysSinceCreated(client);
  const phase = getClientPhase(client);
  const phaseInfo = CLIENT_PHASES.find((p) => p.id === phase);

  const startEditing = () => {
    setEditForm({
      firstName: client.firstName || '',
      lastName: client.lastName || '',
      phone: client.phone || '',
      email: client.email || '',
      address: client.address || '',
      city: client.city || '',
      state: client.state || '',
      zip: client.zip || '',
      contactName: client.contactName || '',
      relationship: client.relationship || '',
      careRecipientName: client.careRecipientName || '',
      careRecipientAge: client.careRecipientAge || '',
      careNeeds: client.careNeeds || '',
      hoursNeeded: client.hoursNeeded || '',
      startDatePreference: client.startDatePreference || '',
      budgetRange: client.budgetRange || '',
      insuranceInfo: client.insuranceInfo || '',
      referralSource: client.referralSource || '',
      referralDetail: client.referralDetail || '',
      assignedTo: client.assignedTo || '',
      priority: client.priority || 'normal',
    });
    setEditing(true);
  };

  const saveEdits = () => {
    onUpdateClient(client.id, editForm);
    setEditing(false);
  };

  const editField = (field, value) => {
    setEditForm((f) => ({ ...f, [field]: value }));
  };

  const profileFields = [
    { label: 'Full Name', value: `${client.firstName || ''} ${client.lastName || ''}`.trim() },
    { label: 'Phone', value: client.phone },
    { label: 'Email', value: client.email },
    { label: 'Address', value: (client.address || client.city) ? [client.address, client.city, client.state, client.zip].filter(Boolean).join(', ') : null },
    { label: 'Contact Person', value: client.contactName },
    { label: 'Relationship', value: client.relationship },
    { label: 'Care Recipient', value: client.careRecipientName },
    { label: 'Care Recipient Age', value: client.careRecipientAge },
    { label: 'Care Needs', value: client.careNeeds },
    { label: 'Hours Needed', value: client.hoursNeeded },
    { label: 'Start Preference', value: client.startDatePreference },
    { label: 'Budget Range', value: client.budgetRange },
    { label: 'Insurance Info', value: client.insuranceInfo },
    { label: 'Referral Source', value: [client.referralSource, client.referralDetail].filter(Boolean).join(' — ') || null },
    { label: 'Assigned To', value: client.assignedTo },
    { label: 'Priority', value: CLIENT_PRIORITIES.find((p) => p.id === client.priority)?.label || 'Normal' },
    { label: 'Current Phase', value: phaseInfo ? `${phaseInfo.icon} ${phaseInfo.label}` : phase },
    { label: 'Days Since Created', value: `${days} day${days !== 1 ? 's' : ''}` },
  ];

  return (
    <div className={cards.profileCard}>
      <div className={cards.profileCardHeader}>
        <h3 className={cards.profileCardTitle}>👤 Client Profile</h3>
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
        <div className={cards.profileGrid}>
          {profileFields.map((item) => (
            <div key={item.label} className={cards.profileItem}>
              <div className={cards.profileLabel}>{item.label}</div>
              <div className={cards.profileValue}>{item.value || '—'}</div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#6B7B8F', marginBottom: 8 }}>Contact Information</div>
          <div className={forms.formGrid}>
            <EditField label="First Name" value={editForm.firstName} onChange={(v) => editField('firstName', v)} />
            <EditField label="Last Name" value={editForm.lastName} onChange={(v) => editField('lastName', v)} />
            <EditField label="Phone" value={editForm.phone} onChange={(v) => editField('phone', v)} />
            <EditField label="Email" value={editForm.email} onChange={(v) => editField('email', v)} />
            <EditField label="Street Address" value={editForm.address} onChange={(v) => editField('address', v)} />
            <EditField label="City" value={editForm.city} onChange={(v) => editField('city', v)} />
            <EditField label="State" value={editForm.state} onChange={(v) => editField('state', v)} />
            <EditField label="Zip Code" value={editForm.zip} onChange={(v) => editField('zip', v)} />
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, color: '#6B7B8F', margin: '16px 0 8px' }}>Care Recipient</div>
          <div className={forms.formGrid}>
            <EditField label="Contact Person" value={editForm.contactName} onChange={(v) => editField('contactName', v)} />
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Relationship</label>
              <select className={forms.fieldInput} value={editForm.relationship} onChange={(e) => editField('relationship', e.target.value)}>
                <option value="">Select...</option>
                <option value="Self">Self</option>
                <option value="Spouse">Spouse</option>
                <option value="Parent">Parent</option>
                <option value="Child">Child</option>
                <option value="Sibling">Sibling</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <EditField label="Care Recipient Name" value={editForm.careRecipientName} onChange={(v) => editField('careRecipientName', v)} />
            <EditField label="Care Recipient Age" value={editForm.careRecipientAge} onChange={(v) => editField('careRecipientAge', v)} type="number" />
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, color: '#6B7B8F', margin: '16px 0 8px' }}>Care Needs</div>
          <div className={forms.formGrid}>
            <div className={forms.field} style={{ gridColumn: '1 / -1' }}>
              <label className={forms.fieldLabel}>Care Needs</label>
              <textarea className={forms.textarea} rows={2} value={editForm.careNeeds} onChange={(e) => editField('careNeeds', e.target.value)} />
            </div>
            <EditField label="Hours Needed" value={editForm.hoursNeeded} onChange={(v) => editField('hoursNeeded', v)} />
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Start Preference</label>
              <select className={forms.fieldInput} value={editForm.startDatePreference} onChange={(e) => editField('startDatePreference', e.target.value)}>
                <option value="">Select...</option>
                <option value="Immediate">Immediate</option>
                <option value="This Week">This Week</option>
                <option value="This Month">This Month</option>
                <option value="Flexible">Flexible</option>
              </select>
            </div>
            <EditField label="Budget Range" value={editForm.budgetRange} onChange={(v) => editField('budgetRange', v)} />
            <EditField label="Insurance Info" value={editForm.insuranceInfo} onChange={(v) => editField('insuranceInfo', v)} />
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, color: '#6B7B8F', margin: '16px 0 8px' }}>Lead Info</div>
          <div className={forms.formGrid}>
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Referral Source</label>
              <select className={forms.fieldInput} value={editForm.referralSource} onChange={(e) => editField('referralSource', e.target.value)}>
                <option value="">Select...</option>
                {CLIENT_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <EditField
              label={editForm.referralSource?.includes('Referral') ? 'Referred By' : 'Source Details'}
              value={editForm.referralDetail}
              onChange={(v) => editField('referralDetail', v)}
            />
            <EditField label="Assigned To" value={editForm.assignedTo} onChange={(v) => editField('assignedTo', v)} />
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Priority</label>
              <select className={forms.fieldInput} value={editForm.priority} onChange={(e) => editField('priority', e.target.value)}>
                {CLIENT_PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
