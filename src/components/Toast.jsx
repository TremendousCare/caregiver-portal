import layout from '../styles/layout.module.css';

export function Toast({ message }) {
  if (!message) return null;
  return (
    <div className={layout.toast}>
      <span style={{ marginRight: 8 }}>✓</span> {message}
    </div>
  );
}
