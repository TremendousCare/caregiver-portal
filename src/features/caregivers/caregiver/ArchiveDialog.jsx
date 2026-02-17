import { useState } from 'react';
import cards from '../../../styles/cards.module.css';
import forms from '../../../styles/forms.module.css';
import btn from '../../../styles/buttons.module.css';
import { ARCHIVE_REASONS } from './constants';

export function ArchiveDialog({ isOpen, onArchive, onCancel }) {
  const [archiveReason, setArchiveReason] = useState('');
  const [archiveDetail, setArchiveDetail] = useState('');

  if (!isOpen) return null;

  const handleArchive = () => {
    onArchive(archiveReason, archiveDetail);
    setArchiveReason('');
    setArchiveDetail('');
  };

  const handleCancel = () => {
    onCancel();
    setArchiveReason('');
    setArchiveDetail('');
  };

  return (
    <div className={cards.alertCard}>
      <strong>Archive this caregiver?</strong>
      <p style={{ margin: '8px 0 12px', fontSize: 13, color: '#556270' }}>They'll be moved out of the active pipeline. You can restore them later.</p>
      <div style={{ marginBottom: 12 }}>
        <label className={forms.fieldLabel}>Reason <span style={{ color: '#DC3545' }}>*</span></label>
        <select className={forms.fieldInput} value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)}>
          <option value="">Select a reason...</option>
          {ARCHIVE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label className={forms.fieldLabel}>Details (optional)</label>
        <input className={forms.fieldInput} placeholder="Any additional context..." value={archiveDetail} onChange={(e) => setArchiveDetail(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className={btn.dangerBtn} style={{ opacity: archiveReason ? 1 : 0.5 }} disabled={!archiveReason} onClick={handleArchive}>Archive</button>
        <button className={btn.secondaryBtn} onClick={handleCancel}>Cancel</button>
      </div>
    </div>
  );
}
