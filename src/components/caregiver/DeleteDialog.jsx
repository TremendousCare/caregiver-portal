import { styles } from '../../styles/theme';

export function DeleteDialog({ isOpen, caregiverName, onDelete, onCancel }) {
  if (!isOpen) return null;

  return (
    <div style={{ ...styles.alertCard, borderColor: '#DC2626', background: '#FEF2F2' }}>
      <strong style={{ color: '#991B1B' }}>Permanently delete this caregiver?</strong>
      <p style={{ margin: '8px 0 12px', fontSize: 13, color: '#7F1D1D' }}>
        This will permanently remove <strong>{caregiverName}</strong> and all their data including notes, tasks, and activity history. This action cannot be undone.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          style={{ ...styles.dangerBtn, background: '#DC2626', color: '#fff' }}
          onClick={onDelete}
        >
          Delete Permanently
        </button>
        <button className="tc-btn-secondary" style={styles.secondaryBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
