import cards from '../../../styles/cards.module.css';
import btn from '../../../styles/buttons.module.css';

export function DeleteDialog({ isOpen, caregiverName, onDelete, onCancel }) {
  if (!isOpen) return null;

  return (
    <div className={cards.alertCard} style={{ borderColor: '#DC2626', background: '#FEF2F2' }}>
      <strong style={{ color: '#991B1B' }}>Permanently delete this caregiver?</strong>
      <p style={{ margin: '8px 0 12px', fontSize: 13, color: '#7F1D1D' }}>
        This will permanently remove <strong>{caregiverName}</strong> and all their data including notes, tasks, and activity history. This action cannot be undone.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className={btn.dangerBtn}
          style={{ background: '#DC2626', color: '#fff' }}
          onClick={onDelete}
        >
          Delete Permanently
        </button>
        <button className={btn.secondaryBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
