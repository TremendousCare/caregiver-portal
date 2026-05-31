import { useState } from 'react';

// Shared collapse primitives for sections that already render their own
// custom header (so they can't be wrapped in <CollapsibleCard> without
// losing their layout). Mirrors CollapsibleCard's chevron + localStorage
// persistence exactly, so collapse behaves identically across the portal.

// Hook: per-key open/closed state persisted in localStorage. Defaults to open.
export function useCollapsed(storageKey, defaultOpen = true) {
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
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
        localStorage.setItem(storageKey, String(next));
      } catch {
        // ignore storage failures
      }
      return next;
    });
  };

  return [open, toggle];
}

// The same rotating chevron used by CollapsibleCard.
export function CollapseChevron({ open }) {
  return (
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
  );
}
