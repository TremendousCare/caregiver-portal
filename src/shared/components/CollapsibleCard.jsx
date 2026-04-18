import { useState } from 'react';
import cards from '../../styles/cards.module.css';

// Shared collapsible card used across Admin Settings.
// Persists open/closed state per-title in localStorage so the user's choice
// survives page reloads. Defaults to collapsed.
export function CollapsibleCard({ title, description, headerRight, defaultOpen = false, storageKey, children }) {
  const key = storageKey || `tc_collapsible_card:${title}`;
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === null) return defaultOpen;
      return stored === 'true';
    } catch {
      return defaultOpen;
    }
  });

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // ignore storage failures
      }
      return next;
    });
  };

  return (
    <div className={cards.profileCard}>
      <div
        className={cards.profileCardHeader}
        style={{
          borderBottom: open ? '1px solid #EDF0F4' : 'none',
        }}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'transparent',
            border: 'none',
            padding: 0,
            margin: 0,
            cursor: 'pointer',
            textAlign: 'left',
            font: 'inherit',
            color: 'inherit',
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            style={{
              transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 0.2s',
              flexShrink: 0,
              color: '#7A8BA0',
            }}
            aria-hidden="true"
          >
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h3 className={cards.profileCardTitle}>{title}</h3>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {description && (
            <span style={{ fontSize: 12, color: '#7A8BA0', fontWeight: 500 }}>{description}</span>
          )}
          {headerRight}
        </div>
      </div>
      {open && children}
    </div>
  );
}
