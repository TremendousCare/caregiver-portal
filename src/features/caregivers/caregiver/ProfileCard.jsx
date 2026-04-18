import { useState } from 'react';
import { PHASES, EMPLOYMENT_STATUSES, AVAILABILITY_TYPES } from '../../../lib/constants';
import { getDaysSinceApplication } from '../../../lib/utils';
import { supabase } from '../../../lib/supabase';
import {
  setCaregiverSmsOptOut,
  setCaregiverAvailabilityCheckPaused,
} from '../../../lib/storage';
import cards from '../../../styles/cards.module.css';
import forms from '../../../styles/forms.module.css';
import btn from '../../../styles/buttons.module.css';
import { EditField } from './constants';

export function ProfileCard({ caregiver, onUpdateCaregiver }) {
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [expanded, setExpanded] = useState(() => localStorage.getItem('tc_profile_expanded') !== 'false');
  const [togglingOptOut, setTogglingOptOut] = useState(false);
  const [togglingAvailPaused, setTogglingAvailPaused] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteMessage, setInviteMessage] = useState(null);

  const isLinked = !!caregiver.userId;

  const handleInvite = async () => {
    if (!supabase || !caregiver.email) return;
    setInviting(true);
    setInviteMessage(null);
    try {
      const { data, error } = await supabase.functions.invoke('caregiver-invite', {
        body: { action: 'send', caregiver_id: caregiver.id },
      });
      if (error) {
        let msg = error.message;
        try {
          const body = await error.context?.json?.();
          if (body?.error) msg = body.error;
        } catch (_) { /* fall through */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      const text = data?.message
        || (data?.already_linked
          ? `This caregiver is already linked. Ask them to sign in at /care.`
          : data?.already_registered
            ? `Already has a login — ask them to sign in at /care.`
            : `Invite email sent to ${data.email}. Check their inbox (and spam).`);
      setInviteMessage({ kind: 'success', text });
    } catch (e) {
      setInviteMessage({ kind: 'error', text: e?.message || 'Failed to send invite.' });
    } finally {
      setInviting(false);
    }
  };

  const days = getDaysSinceApplication(caregiver);

  const handleToggleSmsOptOut = async () => {
    if (togglingOptOut) return;
    const next = !caregiver.smsOptedOut;
    const confirmMsg = next
      ? `Pause all SMS to ${caregiver.firstName}? Automations and manual texts will be blocked until you re-enable.`
      : `Re-subscribe ${caregiver.firstName} to SMS? They will receive automations and manual texts again.`;
    if (!window.confirm(confirmMsg)) return;
    setTogglingOptOut(true);
    try {
      await setCaregiverSmsOptOut(caregiver.id, next, 'admin');
      // Optimistic local update via the parent's updater
      onUpdateCaregiver(caregiver.id, {
        smsOptedOut: next,
        smsOptedOutAt: next ? new Date().toISOString() : null,
        smsOptedOutSource: next ? 'admin' : null,
      });
    } catch (err) {
      console.error('Failed to toggle SMS opt-out:', err);
      window.alert('Failed to update SMS opt-out. Please try again.');
    } finally {
      setTogglingOptOut(false);
    }
  };

  const handleToggleAvailPaused = async () => {
    if (togglingAvailPaused) return;
    const next = !caregiver.availabilityCheckPaused;
    const confirmMsg = next
      ? `Pause availability check-ins for ${caregiver.firstName}? They will stop receiving recurring "update your availability" texts. Other SMS (shift offers, etc.) will continue.`
      : `Resume availability check-ins for ${caregiver.firstName}? They will start receiving the recurring "update your availability" texts again.`;
    if (!window.confirm(confirmMsg)) return;

    let reason = null;
    if (next) {
      const input = window.prompt(
        'Optional reason (shown only to admins in the Paused Check-Ins list):',
        '',
      );
      // prompt returns null on cancel — only proceed if they didn't cancel
      if (input === null) return;
      reason = input.trim() || null;
    }

    setTogglingAvailPaused(true);
    try {
      await setCaregiverAvailabilityCheckPaused(caregiver.id, next, reason);
      onUpdateCaregiver(caregiver.id, {
        availabilityCheckPaused: next,
        availabilityCheckPausedAt: next ? new Date().toISOString() : null,
        availabilityCheckPausedReason: next ? reason : null,
      });
    } catch (err) {
      console.error('Failed to toggle availability check-in pause:', err);
      window.alert('Failed to update. Please try again.');
    } finally {
      setTogglingAvailPaused(false);
    }
  };

  const startEditing = () => {
    setEditForm({
      firstName: caregiver.firstName || '', lastName: caregiver.lastName || '',
      phone: caregiver.phone || '', email: caregiver.email || '',
      address: caregiver.address || '', city: caregiver.city || '',
      state: caregiver.state || '', zip: caregiver.zip || '',
      perId: caregiver.perId || '', hcaExpiration: caregiver.hcaExpiration || '',
      hasHCA: caregiver.hasHCA || '', hasDL: caregiver.hasDL || '', hasVehicle: caregiver.hasVehicle || '',
      availability: caregiver.availability || '', source: caregiver.source || '',
      sourceDetail: caregiver.sourceDetail || '',
      applicationDate: caregiver.applicationDate || '',
      yearsExperience: caregiver.yearsExperience || '',
      languages: caregiver.languages || '',
      specializations: caregiver.specializations || '',
      certifications: caregiver.certifications || '',
      preferredShift: caregiver.preferredShift || '',
      allergies: caregiver.allergies || '',
      clientGenderPreference: caregiver.clientGenderPreference || '',
      initialNotes: caregiver.initialNotes || '',
      employmentStatus: caregiver.employmentStatus || '',
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
    { label: 'HCA Status', value: caregiver.hasHCA === 'yes' ? '✅ Valid HCA ID' : caregiver.hasHCA === 'willing' ? '📝 Willing to register' : caregiver.hasHCA === 'no' ? '❌ No HCA ID' : null },
    { label: "Driver's License", value: caregiver.hasDL === 'yes' ? '✅ Yes' : caregiver.hasDL === 'no' ? '❌ No' : null },
    { label: 'Vehicle', value: caregiver.hasVehicle === 'yes' ? '✅ Yes' : caregiver.hasVehicle === 'no' ? '❌ No' : null },
    { label: 'Availability', value: caregiver.availability },
    { label: 'Source', value: [caregiver.source, caregiver.sourceDetail].filter(Boolean).join(' — ') || null },
    { label: 'Application Date', value: caregiver.applicationDate ? new Date(caregiver.applicationDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null },
    { label: 'Days Since Application', value: `${days} day${days !== 1 ? 's' : ''}` },
    { label: 'Board Status', value: caregiver.boardStatus ? caregiver.boardStatus.charAt(0).toUpperCase() + caregiver.boardStatus.slice(1) : 'Not yet on board' },
    { label: 'Employment Status', value: (() => { const s = EMPLOYMENT_STATUSES.find((st) => st.id === caregiver.employmentStatus); return s ? s.label : null; })() },
    { label: 'Availability Type', value: (() => { const t = AVAILABILITY_TYPES.find((ty) => ty.id === caregiver.availabilityType); return t ? t.label : null; })() },
    { label: 'Current Assignment', value: caregiver.currentAssignment || null },
    { label: 'CPR Expiry Date', value: caregiver.cprExpiryDate ? (() => { const exp = new Date(caregiver.cprExpiryDate + 'T00:00:00'); const du = Math.ceil((exp - new Date()) / 86400000); const ds = exp.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); if (du < 0) return `Expired — ${ds}`; if (du <= 90) return `${ds} (${du} days)`; return `${ds}`; })() : null },
    { label: 'Years of Experience', value: caregiver.yearsExperience ? ({ '0-1': 'Less than 1 year', '1-3': '1–3 years', '3-5': '3–5 years', '5-10': '5–10 years', '10+': '10+ years' }[caregiver.yearsExperience] || caregiver.yearsExperience) : null },
    { label: 'Preferred Shift', value: caregiver.preferredShift ? caregiver.preferredShift.charAt(0).toUpperCase() + caregiver.preferredShift.slice(1) : null },
    { label: 'Languages', value: caregiver.languages },
    { label: 'Specializations', value: caregiver.specializations },
    { label: 'Additional Certifications', value: caregiver.certifications },
    { label: 'Known Allergies', value: caregiver.allergies },
    { label: 'Willing to Work With', value: caregiver.clientGenderPreference === 'both' ? 'Male and female clients' : caregiver.clientGenderPreference === 'female' ? 'Female clients only' : caregiver.clientGenderPreference === 'male' ? 'Male clients only' : null },
    { label: 'Phase Override', value: caregiver.phaseOverride ? (() => { const p = PHASES.find((ph) => ph.id === caregiver.phaseOverride); return `⚙️ ${p?.icon} ${p?.label} (manual)`; })() : 'Auto (based on tasks)' },
  ];

  return (
    <div className={cards.profileCard}>
      <div
        className={cards.profileCardHeader}
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => { const next = !expanded; setExpanded(next); localStorage.setItem('tc_profile_expanded', String(next)); }}
      >
        <h3 className={cards.profileCardTitle}>
          <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', marginRight: 6, fontSize: 12 }}>▶</span>
          👤 Profile Information
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {expanded && !editing && (
            <button className={btn.editBtn} onClick={(e) => { e.stopPropagation(); startEditing(); }}>✏️ Edit</button>
          )}
          {expanded && editing && (
            <div style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
              <button className={btn.primaryBtn} onClick={saveEdits}>Save</button>
              <button className={btn.secondaryBtn} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          )}
        </div>
      </div>

      {expanded && !editing ? (
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
          <div style={{
            padding: '12px 20px 16px',
            borderTop: '1px solid #F0F3F7',
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{
                fontSize: 11, fontWeight: 700, color: '#7A8BA0',
                textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4,
              }}>
                SMS Status
              </div>
              {caregiver.smsOptedOut ? (
                <div style={{ fontSize: 13, color: '#991B1B', fontWeight: 600 }}>
                  🚫 Opted out
                  {caregiver.smsOptedOutSource && (
                    <span style={{ fontWeight: 400, color: '#7A8BA0', marginLeft: 6 }}>
                      ({caregiver.smsOptedOutSource === 'keyword' ? 'replied STOP' : 'paused by admin'})
                    </span>
                  )}
                  {caregiver.smsOptedOutAt && (
                    <span style={{ fontWeight: 400, color: '#7A8BA0', marginLeft: 6 }}>
                      on {new Date(caregiver.smsOptedOutAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: '#15803D', fontWeight: 600 }}>
                  ✓ Active — receiving texts
                </div>
              )}
            </div>
            <button
              className={btn.secondaryBtn}
              onClick={handleToggleSmsOptOut}
              disabled={togglingOptOut}
              style={{ fontSize: 12 }}
            >
              {togglingOptOut
                ? 'Updating…'
                : caregiver.smsOptedOut
                  ? 'Re-subscribe'
                  : 'Pause SMS'}
            </button>
          </div>
          <div style={{
            padding: '12px 20px 16px',
            borderTop: '1px solid #F0F3F7',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{
                fontSize: 11, fontWeight: 700, color: '#7A8BA0',
                textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4,
              }}>
                Availability Check-Ins
              </div>
              {caregiver.availabilityCheckPaused ? (
                <div style={{ fontSize: 13, color: '#A16207', fontWeight: 600 }}>
                  ⏸ Paused
                  {caregiver.availabilityCheckPausedAt && (
                    <span style={{ fontWeight: 400, color: '#7A8BA0', marginLeft: 6 }}>
                      on {new Date(caregiver.availabilityCheckPausedAt).toLocaleDateString()}
                    </span>
                  )}
                  {caregiver.availabilityCheckPausedReason && (
                    <div style={{ fontWeight: 400, color: '#7A8BA0', fontSize: 12, marginTop: 2 }}>
                      "{caregiver.availabilityCheckPausedReason}"
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: '#15803D', fontWeight: 600 }}>
                  ✓ Receiving recurring availability updates
                </div>
              )}
              <div style={{ fontSize: 11, color: '#7A8BA0', marginTop: 2 }}>
                Pausing only stops the "update your availability" recurring texts.
                Other SMS (shift offers, confirmations) continue either way.
              </div>
            </div>
            <button
              className={btn.secondaryBtn}
              onClick={handleToggleAvailPaused}
              disabled={togglingAvailPaused}
              style={{ fontSize: 12 }}
            >
              {togglingAvailPaused
                ? 'Updating…'
                : caregiver.availabilityCheckPaused
                  ? 'Resume'
                  : 'Pause check-ins'}
            </button>
          </div>
          {caregiver.email && (
            <div style={{
              padding: '12px 20px 16px',
              borderTop: '1px solid #F0F3F7',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: '#7A8BA0',
                  textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4,
                }}>
                  Caregiver App Access
                </div>
                <div style={{ fontSize: 13, color: isLinked ? '#15803D' : '#7A8BA0', fontWeight: isLinked ? 600 : 400 }}>
                  {isLinked
                    ? '✓ Linked — can sign in to the mobile app'
                    : 'Not linked yet'}
                </div>
                {inviteMessage && (
                  <div style={{ marginTop: 4, fontSize: 12, color: inviteMessage.kind === 'success' ? '#2E7D4A' : '#C53030' }}>
                    {inviteMessage.text}
                  </div>
                )}
              </div>
              <button
                className={btn.secondaryBtn}
                onClick={handleInvite}
                disabled={inviting}
                style={{ fontSize: 12 }}
              >
                {inviting ? 'Sending…' : isLinked ? 'Resend link' : 'Invite to app'}
              </button>
            </div>
          )}
        </>

      ) : expanded ? (
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
                <option value="">— Not set —</option><option value="yes">Valid HCA ID</option><option value="no">No HCA ID</option><option value="willing">Willing to register</option>
              </select>
            </div>
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Driver's License</label>
              <select className={forms.fieldInput} value={editForm.hasDL} onChange={(e) => editField('hasDL', e.target.value)}>
                <option value="">— Not set —</option><option value="yes">Yes</option><option value="no">No</option>
              </select>
            </div>
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Vehicle</label>
              <select className={forms.fieldInput} value={editForm.hasVehicle} onChange={(e) => editField('hasVehicle', e.target.value)}>
                <option value="">— Not set —</option><option value="yes">Yes</option><option value="no">No</option>
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
                <option value="">— Not set —</option>
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
            <EditField label="Known Allergies" value={editForm.allergies} onChange={(v) => editField('allergies', v)} />
            <div className={forms.field}>
              <label className={forms.fieldLabel}>Willing to Work With</label>
              <select className={forms.fieldInput} value={editForm.clientGenderPreference} onChange={(e) => editField('clientGenderPreference', e.target.value)}>
                <option value="">— Not set —</option>
                <option value="both">Male and female clients</option>
                <option value="female">Female clients only</option>
                <option value="male">Male clients only</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <label className={forms.fieldLabel}>Initial Notes</label>
            <textarea className={forms.textarea} rows={3} value={editForm.initialNotes} onChange={(e) => editField('initialNotes', e.target.value)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
