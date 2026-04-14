import { useEffect, useRef, useState } from 'react';
import styles from './RouteSelectorChip.module.css';

/**
 * Compact "Send from: <route>" chip with a dropdown menu for override.
 * Used in bulk SMS compose flows (Dashboard, ActiveRoster) and optionally
 * anywhere else that needs route selection alongside a send button.
 *
 * Props:
 *   - routes: array of all active routes (from useCommunicationRoutes)
 *   - isRouteConfigured: (route) => boolean — typically from the hook
 *   - value: currently selected category string, or null
 *   - onChange: (category) => void
 *   - disabled: optional, disables the whole chip
 *
 * Unconfigured routes are shown in the menu but disabled with a "not set"
 * badge so admins know to finish configuring them in Admin Settings.
 */
export function RouteSelectorChip({ routes, isRouteConfigured, value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = routes.find((r) => r.category === value) || null;

  return (
    <div className={styles.chipRow} ref={ref}>
      <button
        type="button"
        className={styles.chip}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Change which number this message sends from"
      >
        <span className={styles.chipIcon}>{'\uD83D\uDCF1'}</span>
        <span>Send from: <strong>{selected?.label || '—'}</strong></span>
        <span className={styles.chipArrow}>{'\u25BE'}</span>
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          {routes.map((r) => {
            const configured = isRouteConfigured(r);
            const isActive = r.category === value;
            return (
              <button
                key={r.category}
                type="button"
                role="menuitem"
                className={`${styles.menuItem} ${isActive ? styles.menuItemActive : ''}`}
                disabled={!configured}
                title={!configured ? 'This route has no phone number or JWT configured yet' : undefined}
                onClick={() => {
                  if (!configured) return;
                  onChange(r.category);
                  setOpen(false);
                }}
              >
                <span className={styles.menuItemLabel}>
                  {r.label}
                  {r.is_default && (
                    <span className={styles.defaultBadge}>default</span>
                  )}
                </span>
                {!configured && (
                  <span className={styles.notSetBadge}>not set</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Read-only summary chip used in the confirm step — shows "Sending from: X"
 * without opening a dropdown. Just visual confirmation before the user clicks
 * Send.
 */
export function RouteSummaryLine({ route }) {
  if (!route) return null;
  return (
    <div className={styles.summary}>
      <span>{'\uD83D\uDCF1'}</span>
      <span>Sending from: <strong>{route.label}</strong></span>
    </div>
  );
}
