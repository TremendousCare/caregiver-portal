import { styles } from '../styles/theme';

export function Toast({ message }) {
  if (!message) return null;
  return (
    <div className="tc-toast" style={styles.toast}>
      <span style={{ marginRight: 8 }}>✓</span> {message}
    </div>
  );
}
