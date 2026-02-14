import forms from '../../styles/forms.module.css';

export function EditField({ label, value, onChange, type = 'text' }) {
  return (
    <div className={forms.field}>
      <label className={forms.fieldLabel}>{label}</label>
      <input className={forms.fieldInput} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export const ARCHIVE_REASONS = [
  { value: 'hired', label: 'Hired & Deployed' },
  { value: 'declined_offer', label: 'Declined Offer' },
  { value: 'ghosted', label: 'Ghosted / No Response' },
  { value: 'failed_background', label: 'Failed Background Check' },
  { value: 'withdrew', label: 'Candidate Withdrew' },
  { value: 'no_show', label: 'No-Show to Interview/Orientation' },
  { value: 'not_qualified', label: 'Did Not Meet Requirements' },
  { value: 'duplicate', label: 'Duplicate Entry' },
  { value: 'other', label: 'Other' },
];

export const NOTE_TYPES = [
  { value: 'note', label: 'Internal Note', icon: '📝' },
  { value: 'call', label: 'Phone Call', icon: '📞' },
  { value: 'text', label: 'Text Message', icon: '💬' },
  { value: 'email', label: 'Email', icon: '✉️' },
  { value: 'voicemail', label: 'Voicemail', icon: '📱' },
];

export const NOTE_OUTCOMES = [
  { value: 'connected', label: 'Connected' },
  { value: 'no_answer', label: 'No Answer' },
  { value: 'left_vm', label: 'Left Voicemail' },
  { value: 'responded', label: 'Responded' },
  { value: 'no_response', label: 'No Response' },
];
