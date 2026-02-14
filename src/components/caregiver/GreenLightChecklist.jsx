import { GREEN_LIGHT_ITEMS } from '../../lib/constants';
import { isTaskDone } from '../../lib/utils';
import { styles } from '../../styles/theme';

const TASK_KEYS = [
  ['offer_signed'],
  ['i9_form', 'w4_form', 'emergency_contact', 'employment_agreement'],
  ['background_check', 'hca_cleared'],
  ['tb_test'],
  ['training_assigned'],
];

export function GreenLightChecklist({ isOpen, caregiver, onClose }) {
  if (!isOpen) return null;

  return (
    <div style={styles.greenLightCard}>
      <h3 style={{ margin: '0 0 12px', color: '#1A1A1A', fontFamily: "'Outfit', sans-serif" }}>🛡️ Green Light Checklist</h3>
      <p style={{ margin: '0 0 16px', color: '#556270', fontSize: 13 }}>ALL items must be complete before scheduling Sunday Orientation.</p>
      {GREEN_LIGHT_ITEMS.map((item, i) => {
        const done = TASK_KEYS[i].every((k) => isTaskDone(caregiver.tasks?.[k]));
        return (
          <div key={i} style={styles.greenLightRow}>
            <span style={{ color: done ? '#5BA88B' : '#D4697A', fontSize: 18 }}>{done ? '✓' : '✗'}</span>
            <span style={{ color: done ? '#5BA88B' : '#6B7B8F' }}>{item}</span>
          </div>
        );
      })}
      <button style={{ ...styles.secondaryBtn, marginTop: 12 }} onClick={onClose}>Close</button>
    </div>
  );
}
