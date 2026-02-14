import { useState } from 'react';
import { styles } from '../../styles/theme';
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
    <div style={styles.alertCard}>
      <strong>Archive this caregiver?</strong>
      <p style={{ margin: '8px 0 12px', fontSize: 13, color: '#556270' }}>They'll be moved out of the active pipeline. You can restore them later.</p>
      <div style={{ marginBottom: 12 }}>
        <label style={styles.fieldLabel}>Reason <span style={{ color: '#DC3545' }}>*</span></label>
        <select style={styles.fieldInput} value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)}>
          <option value="">Select a reason...</option>
          {ARCHIVE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={styles.fieldLabel}>Details (optional)</label>
        <input style={styles.fieldInput} placeholder="Any additional context..." value={archiveDetail} onChange={(e) => setArchiveDetail(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={{ ...styles.dangerBtn, opacity: archiveReason ? 1 : 0.5 }} disabled={!archiveReason} onClick={handleArchive}>Archive</button>
        <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={handleCancel}>Cancel</button>
      </div>
    </div>
  );
}
